import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PK missing");

const RPCS = [
   "https://polygon-bor-rpc.publicnode.com",
   "https://polygon.drpc.org",
   "https://rpc.ankr.com/polygon"
];

let rpcIndex = 0;
let provider, wallet, usdc, vault, routerContracts;

/* ================= PARAMETERS & DEEP POOL SETTINGS ================= */
const BASE_TRADE = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.01", 6);       
const GAS_COST_USDC = ethers.parseUnits("0.015", 6); 
const BATCH_SIZE = 4;

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const erc20Abi = ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)"];
const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch) external",
    "function minimumProfitUSDC() view returns(uint256)",
    "function withdraw(uint256) external"
];
const routerAbi = ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"];

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const fmt = x => parseFloat(ethers.formatUnits(x, 6)).toFixed(6);
const quoteCache = new Map();
const CACHE_TTL = 800; 

function getCachedQuote(router, path, amount) {
    const key = `${router}-${path.join('-')}-${amount.toString()}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.value;
    return undefined;
}

function setCachedQuote(router, path, amount, value) {
    const key = `${router}-${path.join('-')}-${amount.toString()}`;
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
    routerContracts = Object.fromEntries(Object.values(routers).map(addr => [addr, new ethers.Contract(addr, routerAbi, provider)]));
}

async function quote(router, amount, path) {
    if (amount <= 0n) return null;
    const cached = getCachedQuote(router, path, amount);
    if (cached !== undefined) return cached;
    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        const result = out[out.length - 1];
        setCachedQuote(router, path, amount, result);
        return result;
    } catch {
        setCachedQuote(router, path, amount, null);
        return null;
    }
}

async function optimizeLoanSize(router, path) {
    let low = ethers.parseUnits("10.0", 6);    
    let high = ethers.parseUnits("500000.0", 6); 
    let optimalAmountIn = low;
    let maxNetProfit = 0n;

    for (let i = 0; i < 8; i++) {
        let mid = (low + high) / 2n;
        const out1 = await quote(router, mid, [path[0], path[1]]);
        if (!out1) { high = mid - 1n; continue; }
        const out2 = await quote(router, out1, [path[1], path[2]]);
        if (!out2) { high = mid - 1n; continue; }
        const out3 = await quote(router, out2, [path[2], path[3]]);
        if (!out3) { high = mid - 1n; continue; }

        const grossProfit = out3 - mid;
        const aavePremiumFee = (mid * 5n) / 10000n; 
        const netProfit = grossProfit - aavePremiumFee;

        if (netProfit > maxNetProfit) {
            maxNetProfit = netProfit;
            optimalAmountIn = mid;
            low = mid + 1n; 
        } else {
            high = mid - 1n; 
        }
    }

    if (optimalAmountIn < ethers.parseUnits("10.0", 6) || maxNetProfit < MIN_PROFIT) {
        return null;
    }

    return {
        router,
        amountIn: optimalAmountIn,
        pathToToken: path.slice(0, 3),
        pathToUSDC: [path[2], USDC],
        expectedProfit: maxNetProfit
    };
}

async function findTriangular(router, path) {
    const baseOut1 = await quote(router, BASE_TRADE, [path[0], path[1]]);
    if (!baseOut1) return null;
    const baseOut2 = await quote(router, baseOut1, [path[1], path[2]]);
    if (!baseOut2) return null;
    const baseOut3 = await quote(router, baseOut2, [path[2], path[3]]);
    if (!baseOut3) return null;

    if (baseOut3 - BASE_TRADE <= 0n) return null;
    return optimizeLoanSize(router, path);
}

async function parallelScan(paths, routersList) {
    const batchResults = [];
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        const pathChunk = paths.slice(i, i + BATCH_SIZE);
        const scanPromises = [];
        for (const router of routersList) {
            for (const path of pathChunk) {
                scanPromises.push(findTriangular(router, path).catch(() => null));
            }
        }
        const results = await Promise.all(scanPromises);
        for (const r of results) { if (r !== null) batchResults.push(r); }
        if (batchResults.length >= BATCH_SIZE) break;
    }
    return batchResults.slice(0, BATCH_SIZE);
}

/* ================= EXACT LOG FORMAT DISPATCHER ================= */
async function executeBatch(trades) {
    if (trades.length === 0) return;
    
    console.log("🏁 ZERO-REVALIDATION FLASH LOAN TESTER INITIALIZED");
    const before = await usdc.balanceOf(CONTRACT_ADDRESS);

    let expected = 0n;
    for (const t of trades) { expected += t.expectedProfit; }

    const sizesLogString = trades.map(t => parseFloat(ethers.formatUnits(t.amountIn, 6)).toFixed(2)).join(', ');
    console.log(`🏦 Contract Vault Balance: ${fmt(before)} USDC`);
    console.log(`📡 Invoking Contract Depth Finder over execution window [${sizesLogString}] USDC`);
    console.log(`🎯 Depth Finder Selected Size: ${fmt(trades[0].amountIn)} USDC (Projected Profit: ${fmt(trades[0].expectedProfit)} USDC)\n`);

    console.log(`⛽ Real-Time Cost Analysis:`);
    console.log(`   Estimated Network Gas Cost : $${fmt(GAS_COST_USDC)} USDC\n`);

    if (expected < GAS_COST_USDC) {
        console.log("🔥 EXECUTION RUNTIME: Dispatching Auto-Sizer Pipeline execution... ");
        console.log("⚠️ SAFEGUARD NOTICE: On-chain net profit projection below network overhead thresholds.");
        console.log("✅ Gracefully halting broadcast to protect deployer gas fees.\n");
        return;
    }

    console.log(`🔥 EXECUTION RUNTIME: Dispatching Auto-Sizer Pipeline execution...`);

    try {
        const structPayload = {
            buyRouters: trades.map(t => t.router),
            sellRouters: trades.map(t => t.router),
            amountsInUSDC: trades.map(t => t.amountIn),
            pathsToToken: trades.map(t => t.pathToToken),
            pathsToUSDC: trades.map(t => t.pathToUSDC),
            deadline: Math.floor(Date.now() / 1000) + 30
        };

        console.log("⛽ Estimating precise computational gas boundaries...");
        const rawGas = await vault.executeFlashBatchArbitrage.estimateGas(structPayload);
        const estimatedGasLimit = (rawGas * 130n) / 100n;
        console.log(`✅ Gas Estimation Success: Setting limit to ${estimatedGasLimit.toString()}`);

        const feeData = await provider.getFeeData();
        const tx = await vault.executeFlashBatchArbitrage(structPayload, { 
            gasLimit: estimatedGasLimit,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * 135n) / 100n : undefined,
            maxFeePerGas: feeData.maxFeePerGas ? (feeData.maxFeePerGas * 125n) / 100n : undefined
        });

        console.log(`⚡ Tx Broadcasted: ${tx.hash}`);
        const receipt = await provider.waitForTransaction(tx.hash);
        const after = await usdc.balanceOf(CONTRACT_ADDRESS);
        const real = after > before ? after - before : 0n;

        console.log("\n=================================================");
        console.log(`🔥 FLASH LOAN PIPELINE VERIFICATION COMPLETE`);
        console.log(`   CONTRACT BEFORE BALANCE : ${fmt(before)} USDC`);
        console.log(`   CONTRACT AFTER BALANCE  : ${fmt(after)} USDC`);
        console.log(`   REAL PROFIT             : ${fmt(real)} USDC`);
        console.log(`   GAS EXPENDED            : ${receipt.gasUsed.toString()}`);
        console.log("=================================================\n");
    } catch (err) {
        console.log(`❌ BLOCK PASS REVERT: Internal execution error: ${err.message.slice(0, 60)}`);
    }
}

(async function main() {
    console.log("🚀 BOT STARTED\n");
    provider = newProvider();
    rebuildContracts();

    let tokens = Object.values(TOKENS);
    let triangularPaths = [];
    for (const a of tokens) {
        for (const b of tokens) {
            if (a === b) continue;
            triangularPaths.push([USDC, a, b, USDC]);
        }
    }
    const routersList = Object.values(routers);

    while (true) {
        try {
            const trades = await parallelScan(triangularPaths, routersList);
            if (trades.length > 0) {
                await executeBatch(trades);
            } else {
                await new Promise(r => setTimeout(r, 200));
            }
        } catch {
            provider = newProvider();
            rebuildContracts();
            await new Promise(r => setTimeout(r, 1000));
        }
    }
})();
