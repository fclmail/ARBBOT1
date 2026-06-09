import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
    // Add more RPCs for redundancy
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const BASE_TRADE = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.00021", 6);
const GAS_COST_USDC = ethers.parseUnits("0.00003", 6);
const BATCH_SIZE = 5;

/* ================= GAS TOP-UP ================= */

const WITHDRAW_THRESHOLD = ethers.parseUnits("3001112", 6);
const WITHDRAW_PERCENT = 10n;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

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

/* ================= ROUTERS ================= */

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS = {
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    // Add other token addresses as needed
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x, 6);

/* ================= CACHE ================= */
const quoteCache = new Map();
const CACHE_TTL = 1000; // 1 second cache TTL

function getCachedQuote(router, path) {
    const key = `${router}-${path.join('-')}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.value;
    }
    return undefined;
}

function setCachedQuote(router, path, value) {
    const key = `${router}-${path.join('-')}`;
    quoteCache.set(key, { value, timestamp: Date.now() });
    // Clean up old cache entries if map gets too large
    if (quoteCache.size > 100000) {
        const now = Date.now();
        for (const [key, entry] of quoteCache) {
            if (now - entry.timestamp > CACHE_TTL) {
                quoteCache.delete(key);
            }
        }
    }
}

/* ================= PROVIDER ================= */

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
        Object.values(routers).map(a => [
            a,
            new ethers.Contract(a, routerAbi, provider)
        ])
    );
}

/* ================= LIQUIDITY DEPTH FINDER ================= */

async function getLiquidityDepth(router, path) {
    try {
        const amountIn = BASE_TRADE; // Starting trade size
        const amountsOut = await routerContracts[router].getAmountsOut(amountIn, path);
        const depth = amountsOut[amountsOut.length - 1]; // Final output amount
        return depth;
    } catch (error) {
        console.error(`Error fetching liquidity depth: ${error.message}`);
        return 0;
    }
}

/* ================= QUOTE (with caching) ================= */

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

/* ================= TRIANGULAR PATH BUILDER ================= */

function buildTriangularPaths() {
    const tokens = Object.values(TOKENS);
    let paths = [];

    for (const a of tokens) {
        for (const b of tokens) {
            if (a === b) continue;
            paths.push([USDC, a, b, USDC]);
        }
    }

    return paths;
}

/* ================= TRIANGULAR FINDER (parallel) ================= */

async function findTriangular(router, path) {
    const baseOut1 = await quote(router, BASE_TRADE, [path[0], path[1]]);
    if (!baseOut1) return null;

    const baseOut2 = await quote(router, baseOut1, [path[1], path[2]]);
    if (!baseOut2) return null;

    const baseOut3 = await quote(router, baseOut2, [path[2], path[3]]);
    if (!baseOut3) return null;

    const profit = baseOut3 - BASE_TRADE;

    if (profit <= 0n || profit < MIN_PROFIT) return null;

    const liquidityDepth = await getLiquidityDepth(router, path);
    const adjustedTradeSize = Math.min(BASE_TRADE, liquidityDepth);

    console.log(
        `TRI FOUND ${fmt(adjustedTradeSize)} → ${fmt(baseOut3)} PROFIT ${fmt(profit)}`
    );

    return {
        router,
        amountIn: adjustedTradeSize,
        pathToToken: path.slice(0, 3),
        pathToUSDC: [path[2], USDC],
        expectedProfit: profit
    };
}

/* ================= PARALLEL SCANNER ================= */

async function parallelScan(paths, routersList) {
    const batchResults = [];

    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        const pathChunk = paths.slice(i, i + BATCH_SIZE);
        const scanPromises = [];

        for (const router of routersList) {
            for (const path of pathChunk) {
                scanPromises.push(
                    findTriangular(router, path).catch(() => null)
                );
            }
        }

        const results = await Promise.all(scanPromises);
        batchResults.push(...results.filter(r => r !== null));

        if (batchResults.length >= BATCH_SIZE) {
            break;
        }
    }

    return batchResults.slice(0, BATCH_SIZE);
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {
    console.log("\n🔥 EXECUTING BATCH");

    const before = await usdc.balanceOf(CONTRACT_ADDRESS);

    let total = 0n;
    let expected = 0n;

    for (const t of trades) {
        total += t.amountIn;
        expected += t.expectedProfit;
    }

    console.log(`USED CAPITAL ${fmt(total)}`);
    console.log(`EXPECTED PROFIT ${fmt(expected)}`);

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

    console.log(`CONTRACT BEFORE ${fmt(before)}`);
    console.log(`CONTRACT AFTER  ${fmt(after)}`);
    console.log(`REAL PROFIT     ${fmt(real)}\n`);

    await topUpGas();
}

/* ================= GAS TOP-UP ================= */

async function topUpGas() {
    try {
        const contractBal = await usdc.balanceOf(CONTRACT_ADDRESS);
        if (contractBal < WITHDRAW_THRESHOLD) return;

        const amount = (contractBal * WITHDRAW_PERCENT) / 100n;

        console.log(`⚡ GAS TOP-UP ${fmt(amount)} USDC`);

        await (await vault.withdraw(amount)).wait();
        await (await usdc.approve(routers.QuickSwap, amount)).wait();

        const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);
        await (await router.swapExactTokensForTokens(amount, 0, [USDC, TOKENS.WMATIC], wallet.address, Math.floor(Date.now() / 1000) + 120)).wait();

        console.log("✅ USDC → WMATIC");

        const wmatic = new ethers.Contract(TOKENS.WMATIC, ["function withdraw(uint256)", "function balanceOf(address) view returns(uint256)"], wallet);
        const bal = await wmatic.balanceOf(wallet.address);

        if (bal > 0n) {
            await (await wmatic.withdraw(bal)).wait();
            console.log("🔥 WMATIC → POL");
        }
    } catch (e) {
        console.log(`⚠️ GAS TOP-UP FAILED: ${e.message}`);
    }
}

/* ================= MAIN ================= */

(async function main() {
    console.log("🚀 BOT STARTED\n");

    provider = newProvider();
    rebuildContracts();

    const triangularPaths = buildTriangularPaths();
    const routersList = Object.values(routers);

    while (true) {
        try {
            const trades = await parallelScan(triangularPaths, routersList);
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
