import dotenv from "dotenv";  
import { ethers } from "ethers";  

dotenv.config({ override: false });  

/* ================= ENV ================= */  
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;  
if (!PRIVATE_KEY) throw new Error("PK missing");  

/* ================= RPC ================= */  
const RPCS = [  
    "https://polygon-bor-rpc.publicnode.com"  
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

/* ================= RATE-LIMIT SAFEGUARDS ================= */  
const CONCURRENCY_LIMIT = 6;   // max simultaneous RPC calls  
const CHUNK_DELAY_MS = 50;     // breathing room between chunks  
const CACHE_TTL = 8000;        // 8s hop-level cache TTL  
const sleep = ms => new Promise(r => setTimeout(r, ms));  

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
    WBTC: "0x1bfd67037b42cf73"  
};  

/* ================= HELPERS & CACHE ================= */  
const fmt = x => ethers.formatUnits(x, 6);  
const quoteCache = new Map();  

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

/* ================= HOP-LEVEL QUOTING WITH CACHE ================= */  
async function quote(router, startAmount, fullPath) {  
    const fullKey = `${router}-${fullPath.join('-')}`;  
    const fullCached = getCachedQuote(router, fullPath);  
    if (fullCached !== undefined) return fullCached;  

    let currentAmount = startAmount;  
    let success = true;  

    for (let i = 0; i < fullPath.length - 1; i++) {  
        const hopPath = [fullPath[i], fullPath[i + 1]];  
        const hopKey = `${router}-${hopPath.join('-')}`;  

        const hopCached = quoteCache.get(hopKey);  
        let hopOut;  

        if (hopCached !== undefined && Date.now() - hopCached.timestamp < CACHE_TTL) {  
            hopOut = hopCached.value;  
        } else {  
            try {  
                const out = await routerContracts[router].getAmountsOut(currentAmount, hopPath);  
                hopOut = out.at(-1);  
                quoteCache.set(hopKey, { value: hopOut, timestamp: Date.now() });  
            } catch {  
                quoteCache.set(hopKey, { value: null, timestamp: Date.now() });  
                success = false;  
                break;  
            }  
        }  
        currentAmount = hopOut;  
    }  

    quoteCache.set(fullKey, { value: success ? currentAmount : null, timestamp: Date.now() });  
    return success ? currentAmount : null;  
}  

/* ================= MULTI-HOP PATH BUILDER ================= */  
function buildMultiHopPaths() {  
    const tokens = Object.values(TOKENS);  
    let paths = [];  

    for (const a of tokens) {  
        for (const b of tokens) {  
            if (a === b) continue;  
            paths.push([USDC, a, b, USDC]);  

            for (const c of tokens) {  
                if (a === c || b === c) continue;  
                paths.push([USDC, a, b, c, USDC]);  
            }  
        }  
    }  

    return [...new Set(paths.map(p => p.join(',')))].map(p => p.split(','));  
}  

const getSymbol = (addr) => Object.keys(TOKENS).find(k => TOKENS[k] === addr) || addr.slice(0, 6);  

/* ================= SIMULATION & SCANNING ================= */  
async function findArbitrageOpportunity(router, path) {  
    const nextOut = await quote(router, BASE_TRADE, path);  
    if (!nextOut) return null;  

    const profit = nextOut - BASE_TRADE;  
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

/* ================= CHUNKED PARALLEL SCAN ================= */  
async function parallelScan(paths, routersList) {  
    const tasks = [];  
    for (const router of routersList) {  
        for (const path of paths) {  
            tasks.push({ router, path });  
        }  
    }  

    const results = [];  
    for (let i = 0; i < tasks.length; i += CONCURRENCY_LIMIT) {  
        if (results.length >= BATCH_SIZE) break;  

        const chunk = tasks.slice(i, i + CONCURRENCY_LIMIT);  

        const chunkResults = await Promise.all(  
            chunk.map(({ router, path }) =>  
                findArbitrageOpportunity(router, path).catch(() => null)  
            )  
        );  

        results.push(...chunkResults.filter(r => r !== null));  

        await sleep(CHUNK_DELAY_MS);  
    }  

    return results.slice(0, BATCH_SIZE);  
}  

/* ================= TX SEND GUARD ================= */  
let pendingTxCount = 0;  
const MAX_IN_FLIGHT = 1;  

async function guardedSend(txPromise) {  
    while (pendingTxCount >= MAX_IN_FLIGHT) {  
        await sleep(750);  
    }  
    pendingTxCount++;  
    try {  
        const tx = await txPromise;  
        await provider.waitForTransaction(tx.hash);  
        return tx;  
    } finally {  
        pendingTxCount--;  
    }  
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

        const tx = await guardedSend(vault.executeFlashBatchArbitrage({  
            buyRouters: trades.map(t => t.router),  
            sellRouters: trades.map(t => t.router),  
            amountsInUSDC: trades.map(t => t.amountIn),  
            pathsToToken: trades.map(t => t.pathToToken),  
            pathsToUSDC: trades.map(t => t.pathToUSDC),  
            deadline: Math.floor(Date.now() / 1000) + 30  
        }));  

        const after = await usdc.balanceOf(CONTRACT_ADDRESS);  
        const real = after > before ? after - before : 0n;  

        console.log(`REAL PROFIT: ${fmt(real)} USDC\n`);  
        await topUpGas();  
    } catch (err) {  
        console.error("⚠️ BATCH EXECUTION REVERTED:", err.message);  
    }  
}  

/* ================= GAS TOP-UP ================= */  
async function topUpGas() {  
    try {  
        const contractBal = await usdc.balanceOf(CONTRACT_ADDRESS);  
        if (contractBal < WITHDRAW_THRESHOLD) return;  

        const amount = (contractBal * WITHDRAW_PERCENT) / 100n;  

        await guardedSend(vault.withdraw(amount));  
        await sleep(1000);  
        await guardedSend(usdc.approve(routers.QuickSwap, amount));  
        await sleep(1000);  

        const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);  
        await guardedSend(router.swapExactTokensForTokens(  
            amount,  
            0,  
            [USDC, TOKENS.WMATIC],  
            wallet.address,  
            Math.floor(Date.now() / 1000) + 120  
        ));  
    } catch (e) {  
        console.log(`⚠️ GAS TOP-UP FAILED: ${e.message}`);  
    }  
}  

/* ================= APPROVE ONCE AT STARTUP ================= */  
async function approveOnce() {  
    try {  
        console.log("🔑 Pre-approving QuickSwap with MAX_UINT256...");  
        await guardedSend(usdc.approve(routers.QuickSwap, ethers.MaxUint256));  
        console.log("✅ QuickSwap approved");  
    } catch (e) {  
        console.log(`⚠️ APPROVE FAILED (will re-try on next cycle): ${e.message}`);  
    }  
}  

/* ================= MAIN LOOP ================= */  
(async function main() {  
    console.log("🚀 BOT STARTED | CACHING + CONCURRENCY-LIMITED PROMISE.ALL + TX GUARD\n");  
    provider = newProvider();  
    rebuildContracts();  

    try {  
        await guardedSend(usdc.approve(vault.target, ethers.MaxUint256));  
        await sleep(1000);  
    } catch (e) {  
        console.log(`⚠️ VAULT USDC APPROVE FAILED: ${e.message}`);  
    }  

    await approveOnce();  

    const multiHopPaths = buildMultiHopPaths();  
    const routersList = Object.values(routers);  
    let lastBlock = 0;  

    console.log(`📊 Paths to scan: ${multiHopPaths.length} | Routers: ${routersList.length}`);  
    console.log(`🛡️ Concurrency cap: ${CONCURRENCY_LIMIT} | Chunk delay: ${CHUNK_DELAY_MS}ms\n`);  

    while (true) {  
        try {  
            const currentBlock = await provider.getBlockNumber();  
            if (currentBlock > lastBlock) {  
                lastBlock = currentBlock;  
                quoteCache.clear();  
            }  

            const trades = await parallelScan(multiHopPaths, routersList);  
            if (trades.length > 0) {  
                await executeBatch(trades);  
            } else {  
                await sleep(500);  
            }  
        } catch (error) {  
            console.error("❌ Error in main loop:", error.message);  
            pendingTxCount = 0;    
            provider = newProvider();  
            rebuildContracts();  
            await sleep(1000);  
        }  
    }  
})();
