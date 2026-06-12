import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */
const RPCS = ["https://polygon-bor-rpc.publicnode.com"];
let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */
const TRADE_SIZES = [
    ethers.parseUnits("0.02", 6),
    ethers.parseUnits("0.05", 6),
    ethers.parseUnits("0.10", 6),
    ethers.parseUnits("0.20", 6),
    ethers.parseUnits("0.50", 6),
    ethers.parseUnits("1.00", 6)
];

const MIN_PROFIT = ethers.parseUnits("0.0002", 6);
const GAS_COST_USDC = ethers.parseUnits("0.00003", 6);
const BATCH_SIZE = 20; // Immediately triggers execution when this limit is hit

/* ================= GAS TOP-UP ================= */
const WITHDRAW_THRESHOLD = ethers.parseUnits("997973", 6);
const WITHDRAW_PERCENT = 1n;

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
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */
const TOKENS = {
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
    UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

const fmt = x => ethers.formatUnits(x, 6);

/* ================= CACHE ================= */
const quoteCache = new Map();
const CACHE_TTL = 600; // Lowered slightly to prevent dead-stale pricing

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
}

function clearCache() {
    quoteCache.clear();
}

/* ================= PROVIDER SETUP ================= */
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

/* ================= QUOTE ================= */
async function quote(router, amount, path, skipCache = false) {
    if (!skipCache) {
        const cached = getCachedQuote(router, path);
        if (cached !== undefined) return cached;
    }
    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        const result = out.at(-1);
        if (!skipCache) setCachedQuote(router, path, result);
        return result;
    } catch {
        if (!skipCache) setCachedQuote(router, path, null);
        return null;
    }
}

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

/* ================= TRIANGULAR FINDER ================= */
async function findTriangular(router, path, skipCache = false) {
    let bestSize = null;
    let maxProfit = 0n;

    for (const size of TRADE_SIZES) {
        const out1 = await quote(router, size, [path[0], path[1]], skipCache);
        if (!out1) continue;
        const out2 = await quote(router, out1, [path[1], path[2]], skipCache);
        if (!out2) continue;
        const out3 = await quote(router, out2, [path[2], path[3]], skipCache);
        if (!out3) continue;

        const profit = out3 - size;

        if (profit >= MIN_PROFIT && profit > maxProfit) {
            maxProfit = profit;
            bestSize = {
                router,
                amountIn: size,
                pathToToken: path.slice(0, 3),
                pathToUSDC: [path[2], USDC],
                expectedProfit: profit,
                rawOutput: out3
            };
        }
    }
    return bestSize;
}

/* ================= EXECUTE BATCH ================= */
async function executeBatch(trades) {
    console.log("\n🔥 EXECUTING BATCH IMMEDIATELY");
    const before = await usdc.balanceOf(CONTRACT_ADDRESS);
    let total = 0n;
    let expected = 0n;

    for (const t of trades) {
        total += t.amountIn;
        expected += t.expectedProfit;
    }

    console.log(`USED CAPITAL: ${fmt(total)} USDC`);
    console.log(`EXPECTED NET YIELD: ${fmt(expected)} USDC`);

    if (expected < GAS_COST_USDC) {
        console.log("❌ SKIPPED: BELOW GAS THRESHOLD\n");
        return;
    }

    try {
        const tx = await vault.executeFlashBatchArbitrage({
            buyRouters: trades.map(t => t.router),
            sellRouters: trades.map(t => t.router),
            amountsInUSDC: trades.map(t => t.amountIn),
            pathsToToken: trades.map(t => t.pathToToken),
            pathsToUSDC: trades.map(t => t.pathToUSDC),
            deadline: Math.floor(Date.now() / 1000) + 60 // Lowered deadline for speed
        });

        console.log(`📡 Tx Sent: ${tx.hash}. Waiting finalization...`);
        await provider.waitForTransaction(tx.hash);

        const after = await usdc.balanceOf(CONTRACT_ADDRESS);
        const real = after > before ? after - before : 0n;

        console.log(`CONTRACT BEFORE: ${fmt(before)}`);
        console.log(`CONTRACT AFTER:  ${fmt(after)}`);
        console.log(`💰 REALIZED PROFIT: ${fmt(real)} USDC\n`);

        clearCache(); // Flush out stale quotes right after state change execution
        await topUpGas();
    } catch (err) {
        console.error("❌ TRANSACTION REJECTED/REVERTED:", err.message);
    }
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
        await (
            await router.swapExactTokensForTokens(
                amount,
                0,
                [USDC, TOKENS.WMATIC],
                wallet.address,
                Math.floor(Date.now() / 1000) + 120
            )
        ).wait();
        console.log("✅ USDC → WMATIC");
        const wmatic = new ethers.Contract(
            TOKENS.WMATIC,
            ["function withdraw(uint256)", "function balanceOf(address) view returns(uint256)"],
            wallet
        );
        const bal = await wmatic.balanceOf(wallet.address);
        if (bal > 0n) {
            await (await wmatic.withdraw(bal)).wait();
            console.log("🔥 WMATIC → POL");
        }
    } catch (e) {
        console.log(`⚠️ GAS TOP-UP FAILED: ${e.message}`);
    }
}

/* ================= MAIN INTERLEAVED EXECUTION LOOP ================= */
(async function main() {
    console.log("🚀 BOT STARTED - HIGH SPEED SHORT-CIRCUIT MODE\n");
    provider = newProvider();
    rebuildContracts();
    
    const triangularPaths = buildTriangularPaths();
    const routersList = Object.values(routers);

    while (true) {
        try {
            let activeBatch = [];
            clearCache(); // Clear memory profiles at start of iteration

            // Process chunks with early termination checks
            for (let i = 0; i < triangularPaths.length; i += 4) {
                const pathChunk = triangularPaths.slice(i, i + 4);
                const scanPromises = [];

                for (const router of routersList) {
                    for (const path of pathChunk) {
                        scanPromises.push(findTriangular(router, path, false));
                    }
                }

                const results = await Promise.all(scanPromises);
                const validTrades = results.filter(r => r !== null);

                if (validTrades.length > 0) {
                    activeBatch.push(...validTrades);
                    console.log(`[Collection]: ${activeBatch.length}/${BATCH_SIZE} live variants collected.`);
                }

                // SHORT CIRCUIT: Execute immediately when our target batch size is achieved
                if (activeBatch.length >= BATCH_SIZE) {
                    const candidates = activeBatch.slice(0, BATCH_SIZE);
                    console.log(`\n⚡ Target batch size reached (${BATCH_SIZE}). Short-circuiting scan loop for immediate check!`);
                    
                    console.log(`🔍 Re-verifying ${candidates.length} accumulated trades against real-time pools (Cache Bypassed)...`);
                    const tradesToExecute = [];

                    for (const t of candidates) {
                        const path = [...t.pathToToken, t.pathToUSDC[1]];
                        // skipCache is flagged as true here to force an on-chain real-time block query
                        const liveTrade = await findTriangular(t.router, path, true); 
                        
                        if (liveTrade && liveTrade.expectedProfit > 0n) {
                            tradesToExecute.push(liveTrade);
                            console.log(`✅ Position Confirmed: Yielding ${fmt(liveTrade.expectedProfit)} USDC`);
                        } else {
                            console.log(`❌ Position Expired/Stale: Discarded.`);
                        }
                    }

                    if (tradesToExecute.length > 0) {
                        await executeBatch(tradesToExecute);
                    } else {
                        console.log("⚠️ Batch Cancelled: All items went stale. Resuming scans...\n");
                    }

                    // Reset our active buffer tracking arrays completely and step back out
                    activeBatch = [];
                    break; 
                }
            }

            // Minimal cool down to prevent rate limit blocks if no trades were encountered
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            console.error("❌ Error in main loop:", error.message);
            provider = newProvider();
            rebuildContracts();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
})();
