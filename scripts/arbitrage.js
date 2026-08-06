import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */
const RPCS = ["https://chainid.network/chain/137"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */
const BATCH_SIZE = 3; 
const BASE_TRADE = ethers.parseUnits(".05", 6);
const MIN_PROFIT = ethers.parseUnits("0.0002", 6);
const GAS_COST_USDC = ethers.parseUnits("0.00003", 6);

/* ================= GAS TOP-UP ================= */
const WITHDRAW_THRESHOLD = ethers.parseUnits("997973", 6);
const WITHDRAW_PERCENT = 1n;

/* ================= CONTRACTS ================= */
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
    "function withdraw(uint256)"
];

const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])",
    "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const TOKENS = {
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS & CACHE ================= */
const fmt = x => ethers.formatUnits(x, 6);
const quoteCache = new Map();
const CACHE_TTL = 1000;

function getCachedQuote(router, path) {
    const key = `${router}-${path.join('-')}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.value;
    return undefined;
}

function setCachedQuote(router, path, value) {
    const key = `${router}-${path.join('-')}`;
    quoteCache.set(key, { value, timestamp: Date.now() });
}

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
    routerContracts = Object.fromEntries(
        Object.values(routers).map(a => [a, new ethers.Contract(a, routerAbi, provider)])
    );
}

async function quote(router, amount, path) {
    const cached = getCachedQuote(router, path);
    if (cached !== undefined) return cached;
    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        const result = out.at(-1);
        setCachedQuote(router, path, result);
        return result;
    } catch {
        setCachedQuote(router, path, null);
        return null;
    }
}

/* ================= MULTI-HOP PATH BUILDER ================= */
function buildMultiHopPaths() {
    const tokens = Object.values(TOKENS);
    let paths = [];
    
    // Triangular and Multi-Hop Combinations (Supports 2 to 3 intermediate token hops)
    for (const a of tokens) {
        for (const b of tokens) {
            if (a === b) continue;
            // 3-step hop (Standard Triangular)
            paths.push([USDC, a, b, USDC]);
            
            for (const c of tokens) {
                if (a === c || b === c) continue;
                // 4-step hop (Advanced Multi-Hop Arbitrage)
                paths.push([USDC, a, b, c, USDC]);
            }
        }
    }
    return paths;
}

const getSymbol = (addr) => Object.keys(TOKENS).find(k => TOKENS[k] === addr) || addr.slice(0, 6);

/* ================= SIMULATION & SCANNING ================= */
async function findArbitrageOpportunity(router, path) {
    let currentAmount = BASE_TRADE;
    
    // Dynamically iterate through all intermediate hops
    for (let i = 0; i < path.length - 1; i++) {
        const hopPath = [path[i], path[i + 1]];
        const nextOut = await quote(router, currentAmount, hopPath);
        if (!nextOut) return null;
        currentAmount = nextOut;
    }

    const profit = currentAmount - BASE_TRADE;
    if (profit <= 0n || profit < MIN_PROFIT) return null;

    const routeDescription = path.map(addr => getSymbol(addr)).join("->");
    console.log(`🔔 OPPORTUNITY FOUND | Route: ${routeDescription} | Profit: ${fmt(profit)} USDC`);

    return {
        router,
        amountIn: BASE_TRADE,
        pathToToken: path.slice(0, path.length - 1),
        pathToUSDC: [path[path.length - 2], USDC],
        expectedProfit: profit
    };
}

async function parallelScan(paths, routersList) {
    const batchResults = [];
    
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        const pathChunk = paths.slice(i, i + BATCH_SIZE);
        const scanPromises = [];

        for (const router of routersList) {
            for (const path of pathChunk) {
                scanPromises.push(findArbitrageOpportunity(router, path).catch(() => null));
            }
        }

        const results = await Promise.all(scanPromises);
        batchResults.push(...results.filter(r => r !== null));

        if (batchResults.length >= BATCH_SIZE) break;
    }
    return batchResults.slice(0, BATCH_SIZE);
}

/* ================= EXECUTION CORES ================= */
async function executeBatch(trades) {
    console.log("\n🔥 EXECUTING BATCH");
    try {
        const before = await usdc.balanceOf(CONTRACT_ADDRESS);
        let total = 0n;
        let expected = 0n;

        for (const t of trades) {
            total += t.amountIn;
            expected += t.expectedProfit;
        }

        if (expected < GAS_COST_USDC) {
            console.log("❌ SKIPPED: BELOW GAS\n");
            return;
        }

        const tx = await vault.executeFlashBatchArbitrage({
            buyRouters: trades.map(t => t.router),
            sellRouters: trades.map(t => t.router),
            amountsInUSDC: trades.map(t => t.amountIn),
            pathsToToken: trades.map(t => t.pathToToken),
            pathsToUSDC: trades.map(t => t.pathToUSDC),
            deadline: Math.floor(Date.now() / 1000) + 30
        });

        await provider.waitForTransaction(tx.hash);
        const after = await usdc.balanceOf(CONTRACT_ADDRESS);
        const real = after > before ? after - before : 0n;

        console.log(`REAL PROFIT: ${fmt(real)} USDC\n`);
        await topUpGas();
    } catch (err) {
        console.error("⚠️ BATCH EXECUTION REVERTED:", err.message);
    }
}

async function topUpGas() {
    try {
        const contractBal = await usdc.balanceOf(CONTRACT_ADDRESS);
        if (contractBal < WITHDRAW_THRESHOLD) return;

        const amount = (contractBal * WITHDRAW_PERCENT) / 100n;
        await (await vault.withdraw(amount)).wait();
        await (await usdc.approve(routers.QuickSwap, amount)).wait();

        const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);
        await (await router.swapExactTokensForTokens(
            amount,
            0,
            [USDC, TOKENS.WMATIC],
            wallet.address,
            Math.floor(Date.now() / 1000) + 120
        )).wait();
    } catch (e) {
        console.log(`⚠️ GAS TOP-UP FAILED: ${e.message}`);
    }
}

/* ================= MAIN LOOP ================= */
(async function main() {
    console.log("🚀 BOT STARTED WITH CACHING & MULTI-HOP PROMISE.ALL\n");
    provider = newProvider();
    rebuildContracts();

    const multiHopPaths = buildMultiHopPaths();
    const routersList = Object.values(routers);
    let lastBlock = 0;

    while (true) {
        try {
            const currentBlock = await provider.getBlockNumber();
            if (currentBlock > lastBlock) {
                lastBlock = currentBlock;
                // Clear cache on new block to ensure freshness
                quoteCache.clear(); 
            }

            const trades = await parallelScan(multiHopPaths, routersList);
            if (trades.length > 0) {
                await executeBatch(trades);
            } else {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            console.error("❌ Error in main loop:", error.message);
            provider = newProvider();
            rebuildContracts();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
})();
