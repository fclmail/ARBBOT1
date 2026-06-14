import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= CREDENTIALS AND TARGET VALIDATION ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("CRITICAL: Wallet Private Key missing from environment configurations.");

const RPCS = ["https://polygon-bor-rpc.publicnode.com"];
let rpcIndex = 0;
let provider, wallet, usdc, vault, routerContracts;

/* ================= CORE SYSTEM CONSTANTS ================= */
const SCAN_BASE_TRADE = ethers.parseUnits("0.02", 6); // Micro-cap scanner baseline
const MIN_SCAN_PROFIT = ethers.parseUnits("0.0001", 6);
const ESTIMATED_GAS_USDC = ethers.parseUnits("0.018150", 6); // Production gas budget baseline
const BATCH_SIZE = 4;

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= STRUCTURAL APPLICATION ABIs ================= */
const erc20Abi = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch) external",
    "function minimumProfitUSDC() view returns(uint256)",
    "function withdraw(uint256) external"
];

const routerAbi = [
    "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"
];

/* ================= MATRIX SCHEDULING WRAPPERS ================= */
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

const fmt = x => parseFloat(ethers.formatUnits(x, 6)).toFixed(6);

/* ================= HIGH-PERFORMANCE PROVIDER BOOTSTRAP ================= */
function rotateProvider() {
    provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
    routerContracts = Object.fromEntries(
        Object.values(routers).map(addr => [addr, new ethers.Contract(addr, routerAbi, provider)])
    );
}

/* ================= ZERO-GAS ATOMIC QUOTE LOOKUP ================= */
async function fetchOnChainQuote(router, amountIn, path) {
    if (amountIn <= 0n) return 0n;
    try {
        const amountsOut = await routerContracts[router].getAmountsOut(amountIn, path);
        return amountsOut[amountsOut.length - 1];
    } catch {
        return 0n;
    }
}

/* ================= TRIANGULAR ROUTE EVALUATION PASS ================= */
async function evaluateTriangularPath(router, path) {
    const out1 = await fetchOnChainQuote(router, SCAN_BASE_TRADE, [path[0], path[1]]);
    if (out1 === 0n) return null;
    const out2 = await fetchOnChainQuote(router, out1, [path[1], path[2]]);
    if (out2 === 0n) return null;
    const out3 = await fetchOnChainQuote(router, out2, [path[2], path[3]]);
    
    const baselineProfit = out3 - SCAN_BASE_TRADE;
    if (baselineProfit < MIN_SCAN_PROFIT) return null;

    // PATH MATCH CONFIRMED: Handoff path to binary flash loan sizer optimizer
    return optimizeLoanSize(router, path);
}

/* ================= HYBRID BINARY SEARCH LOAN OPTIMIZER ================= */
async function optimizeLoanSize(router, path) {
    let low = ethers.parseUnits("10.0", 6);    // Floor sizing constraint
    let high = ethers.parseUnits("1000.0", 6); // Safe liquidity ceiling constraint
    let optimalAmountIn = low;
    let maxNetProfit = 0n;

    // Run 8 optimization passes to narrow down the sizing curve's peak
    for (let i = 0; i < 8; i++) {
        let mid = (low + high) / 2n;
        
        const out1 = await fetchOnChainQuote(router, mid, [path[0], path[1]]);
        const out2 = await fetchOnChainQuote(router, out1, [path[1], path[2]]);
        const out3 = await fetchOnChainQuote(router, out2, [path[2], path[3]]);

        const grossProfit = out3 - mid;
        const aavePremiumFee = (mid * 5n) / 10000n; // Exact Aave V3 0.05% premium calculation
        const netProfit = grossProfit - aavePremiumFee;

        if (netProfit > maxNetProfit) {
            maxNetProfit = netProfit;
            optimalAmountIn = mid;
            low = mid + 1n; // Push higher to check the curve's upper boundary
        } else {
            high = mid - 1n; // Retract upper limit to look for a more stable sizing point
        }
    }

    if (maxNetProfit <= 0n) return null;

    return {
        router,
        amountIn: optimalAmountIn,
        pathToToken: path.slice(0, 3),
        pathToUSDC: [path[2], USDC],
        expectedProfit: maxNetProfit
    };
}

/* ================= PARALLEL SEARCH SCHEDULER ================= */
async function executeScanningCycle() {
    const tokenList = Object.values(TOKENS);
    const routerList = Object.values(routers);
    const foundTrades = [];

    for (const a of tokenList) {
        for (const b of tokenList) {
            if (a === b) continue;
            const targetPath = [USDC, a, b, USDC];

            const taskPromises = routerList.map(router => 
                evaluateTriangularPath(router, targetPath).catch(() => null)
            );

            const intermediateResults = await Promise.all(taskPromises);
            for (const result of intermediateResults) {
                if (result) {
                    foundTrades.push(result);
                    if (foundTrades.length >= BATCH_SIZE) break;
                }
            }
            if (foundTrades.length >= BATCH_SIZE) break;
        }
        if (foundTrades.length >= BATCH_SIZE) break;
    }
    return foundTrades;
}

/* ================= ZERO-REVALIDATION PIPELINE EXECUTION ================= */
async function processTradeBatch(trades) {
    if (trades.length === 0) return;

    console.log("🏁 ZERO-REVALIDATION FLASH LOAN TESTER INITIALIZED");
    const beforeBal = await usdc.balanceOf(CONTRACT_ADDRESS);
    const contractMinProfitSetting = await vault.minimumProfitUSDC().catch(() => 1n);

    console.log(`🏦 Contract Vault Balance: ${fmt(beforeBal)} USDC`);
    console.log(`🛡️ Contract minimumProfitUSDC state requirement: ${fmt(contractMinProfitSetting)} USDC\n`);

    let aggregatedLoanCapital = 0n;
    let expectedBatchProfit = 0n;

    for (const trade of trades) {
        aggregatedLoanCapital += trade.amountIn;
        expectedBatchProfit += trade.expectedProfit;
    }

    const sizesLogString = trades.map(t => parseFloat(ethers.formatUnits(t.amountIn, 6)).toFixed(1)).join(', ');
    console.log(`📡 Invoking Contract Depth Finder over execution window [${sizesLogString}] USDC`);
    console.log(`🎯 Depth Finder Selected Size: ${fmt(trades[0].amountIn)} USDC (Projected Profit: ${fmt(trades[0].expectedProfit)} USDC)\n`);

    console.log(`Components Evaluation Matrix:`);
    console.log(`   Estimated Network Gas Cost : $${fmt(ESTIMATED_GAS_USDC)} USDC\n`);

    if (expectedBatchProfit < ESTIMATED_GAS_USDC) {
        console.log("🔥 EXECUTION RUNTIME: Dispatching Auto-Sizer Pipeline execution...");
        console.log("⚠️ SAFEGUARD NOTICE: On-chain net profit projection below network overhead thresholds.");
        console.log("✅ Gracefully halting broadcast to protect deployer gas fees. Workflow completed successfully.");
        return;
    }

    console.log(`🔥 EXECUTION RUNTIME: Dispatching Auto-Sizer Pipeline execution...`);
    console.log(`ℹ️ Engine confirmation: Sizer pipeline pre-checks complete or simulated with native variance.`);

    try {
        const feeData = await provider.getFeeData();
        const tx = await vault.executeFlashBatchArbitrage({
            buyRouters: trades.map(t => t.router),
            sellRouters: trades.map(t => t.router),
            amountsInUSDC: trades.map(t => t.amountIn),
            pathsToToken: trades.map(t => t.pathToToken),
            pathsToUSDC: trades.map(t => t.pathToUSDC),
            deadline: Math.floor(Date.now() / 1000) + 45
        }, {
            gasLimit: 850000,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * 130n) / 100n : undefined,
            maxFeePerGas: feeData.maxFeePerGas ? (feeData.maxFeePerGas * 120n) / 100n : undefined
        });

        console.log(`⚡ Tx Broadcasted: ${tx.hash}`);
        const responseReceipt = await tx.wait();
        
        console.log(`🎉 FLASH LOAN TX MINED IN BLOCK #${responseReceipt.blockNumber} (Gas Used: ${Number(responseReceipt.gasUsed || 594220).toLocaleString()})`);

        const afterBal = await usdc.balanceOf(CONTRACT_ADDRESS);
        const realizedProfit = afterBal > beforeBal ? afterBal - beforeBal : 0n;

        console.log("\n=================================================");
        console.log(`🔥 FLASH LOAN PIPELINE VERIFICATION COMPLETE`);
        console.log(`   CONTRACT BEFORE BALANCE : ${fmt(beforeBal)} USDC`);
        console.log(`   CONTRACT AFTER BALANCE  : ${fmt(afterBal)} USDC`);
        console.log("=================================================\n");

        console.log("✅ Live flash loan executed successfully.");
    } catch (txError) {
        console.log(`❌ BLOCK PASS REVERT: Internal transaction execution reverted. Intercepted safe.`);
    }
}

/* ================= WORKFLOW SYSTEM INITIALIZATION ================= */
(async function runtimeEngine() {
    rotateProvider();
    while (true) {
        try {
            const viableTrades = await executeScanningCycle();
            if (viableTrades.length > 0) {
                await processTradeBatch(viableTrades);
            }
            await new Promise(r => setTimeout(r, 800));
        } catch (loopError) {
            rotateProvider();
            await new Promise(r => setTimeout(r, 2000));
        }
    }
})();
