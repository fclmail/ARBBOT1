import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config({ override: false });

/* ================= CREDENTIALS VALIDATION ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

/* ================= HIGH-PERFORMANCE RPC POOL ================= */
const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
];
let rpcIndex = 0;

/* ================= BOT CONFIGURATION ================= */
const MIN_MULTIPLIER_SIZE = ethers.parseUnits("0.02", 6);  // Floor test size ($0.02 USDC)
const MULTIPLIER_STEPS = 5;                               // Number of candidate steps to test off-chain
const BATCH_SIZE = 2;                                     // Multi-hop layout chunks processed at once
const MIN_PROFIT_PER_TRADE = ethers.parseUnits("0.000001", 6); // Global minimum yield limit floor

/* ================= CORE CONTRACT TARGETS ================= */
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"; // Native Polygon USDT (6 Decimals)

const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory amounts)"];
const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch) external",
    "function usdc() view returns (address)"
];

/* ================= DEX ROUTERS MATRIX ================= */
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= CROSS-TOKEN ROUTE MATRIX ================= */
const TOKENS = {
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
};

/* ================= RUNTIME STATE VARIABLES ================= */
let provider;
let wallet;
let vault;
let usdcContract;

function rotateNetworkProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    provider = new ethers.JsonRpcProvider(url);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
    usdcContract = new ethers.Contract(USDC, erc20Abi, provider);
}

/* ================= ADVANCED MULTI-HOP MATRIX BUILDER ================= */
function buildRawTriangularMatrix() {
    const routersList = Object.values(routers);
    const rawBatches = [];

    const WETH = TOKENS.WETH;
    const WMATIC = TOKENS.WMATIC;

    for (const router of routersList) {
        // Path Formula 1: USDC -> WMATIC -> WETH -> USDT -> USDC
        rawBatches.push({
            buyRouter: router,
            sellRouter: router,
            amountInUSDC: MIN_MULTIPLIER_SIZE,
            pathToToken: [USDC, WMATIC, WETH],
            pathToUSDC: [WETH, USDT, USDC]
        });

        // Path Formula 2: USDC -> WETH -> WMATIC -> USDT -> USDC
        rawBatches.push({
            buyRouter: router,
            sellRouter: router,
            amountInUSDC: MIN_MULTIPLIER_SIZE,
            pathToToken: [USDC, WETH, WMATIC],
            pathToUSDC: [WMATIC, USDT, USDC]
        });

        // Path Formula 3: USDC -> USDT -> WETH -> WMATIC -> USDC
        rawBatches.push({
            buyRouter: router,
            sellRouter: router,
            amountInUSDC: MIN_MULTIPLIER_SIZE,
            pathToToken: [USDC, USDT, WETH],
            pathToUSDC: [WETH, WMATIC, USDC]
        });

        // Path Formula 4: USDC -> USDT -> WMATIC -> WETH -> USDC
        rawBatches.push({
            buyRouter: router,
            sellRouter: router,
            amountInUSDC: MIN_MULTIPLIER_SIZE,
            pathToToken: [USDC, USDT, WMATIC],
            pathToUSDC: [WMATIC, WETH, USDC]
        });
    }
    return rawBatches;
}

/* ================= HIGH-SPEED MULTI-HOP SIMULATE-THEN-EXECUTE ENGINE ================= */
async function sendRawBatchToContract(trades) {
    const deadline = Math.floor(Date.now() / 1000) + 120;

    try {
        // 1. Snapshot available capital structures to bind multipliers
        const balanceBefore = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        
        if (balanceBefore < MIN_MULTIPLIER_SIZE) {
            console.log(`⚠️ SIMULATION SKIPPED: Vault balance (${ethers.formatUnits(balanceBefore, 6)} USDC) below minimal step size allocation.`);
            return;
        }

        // 2. Generate a dynamic candidate sizing matrix up to current maximum balance
        const dynamicCandidates = [];
        const maxChunkSize = balanceBefore / BigInt(BATCH_SIZE); 
        const stepDelta = (maxChunkSize - MIN_MULTIPLIER_SIZE) / BigInt(MULTIPLIER_STEPS > 1 ? MULTIPLIER_STEPS - 1 : 1);

        for (let i = 0; i < MULTIPLIER_STEPS; i++) {
            const size = MIN_MULTIPLIER_SIZE + (stepDelta * BigInt(i));
            if (size <= maxChunkSize && size > 0n) {
                dynamicCandidates.push(size);
            }
        }

        console.log(`📡 Simulating ${trades.length} routes using dynamic multipliers: [${dynamicCandidates.map(c => ethers.formatUnits(c, 6)).join(", ")}] USDC`);
        console.log(`🔍 [SIMULATION] Testing batch against exact block state...`);

        let optimizedBatchTrades = [];
        let totalExpectedProfit = 0n;
        let batchValid = true;

        // 3. Loop and evaluate per-trade performance over multiple candidate sizes
        for (let i = 0; i < trades.length; i++) {
            const trade = trades[i];
            let bestTradeProfit = 0n;
            let optimalSizeForRoute = MIN_MULTIPLIER_SIZE;

            try {
                const routerContract = new ethers.Contract(trade.buyRouter, routerAbi, provider);
                
                for (const candidateSize of dynamicCandidates) {
                    // Leg 1 (USDC -> Token A -> Token B)
                    const buyAmounts = await routerContract.getAmountsOut(candidateSize, trade.pathToToken);
                    const tokenBAmount = buyAmounts[buyAmounts.length - 1];
                    
                    // Leg 2 (Token B -> USDT/Token C -> USDC)
                    const sellAmounts = await routerContract.getAmountsOut(tokenBAmount, trade.pathToUSDC);
                    const finalUSDC = sellAmounts[sellAmounts.length - 1];
                    
                    const tradeProfit = finalUSDC > candidateSize ? (finalUSDC - candidateSize) : 0n;
                    
                    if (tradeProfit > bestTradeProfit) {
                        bestTradeProfit = tradeProfit;
                        optimalSizeForRoute = candidateSize;
                    }
                }

                // STRICT CHECK: Does our absolute optimized sizing cross our profit floor threshold?
                if (bestTradeProfit < MIN_PROFIT_PER_TRADE) {
                    console.log(`⚠️ ROUTE SKIPPED: Trade #${i + 1} expected profit (+${ethers.formatUnits(bestTradeProfit, 6)} USDC) is below floor (${ethers.formatUnits(MIN_PROFIT_PER_TRADE, 6)} USDC) at all scaling levels.`);
                    batchValid = false;
                    break; 
                }

                totalExpectedProfit += bestTradeProfit;
                optimizedBatchTrades.push({
                    ...trade,
                    calculatedOptimalSize: optimalSizeForRoute
                });

            } catch (err) {
                console.log(`⚠️ ROUTE SKIPPED: Trade #${i + 1} simulation reverted due to pool conditions.`);
                batchValid = false;
                break;
            }
        }

        // 4. STRICT PRE-FLIGHT GUARD
        if (!batchValid || optimizedBatchTrades.length !== trades.length || totalExpectedProfit <= 0n) {
            console.log(`🛑 Aborting live pool broadcast for this batch to protect capital.\n`);
            return;
        }

        // 5. Structure payload using custom optimal sizing variables
        const payload = {
            buyRouters: optimizedBatchTrades.map(t => t.buyRouter),
            sellRouters: optimizedBatchTrades.map(t => t.sellRouter),
            amountsInUSDC: optimizedBatchTrades.map(t => t.calculatedOptimalSize),
            pathsToToken: optimizedBatchTrades.map(t => t.pathToToken),
            pathsToUSDC: optimizedBatchTrades.map(t => t.pathToUSDC),
            deadline: deadline
        };

        // Static check auth/mechanics
        await vault.executeFlashBatchArbitrage.staticCall(payload);

        console.log(`🔥 SIMULATION SUCCESSFUL: Expected Batch Profit: +${ethers.formatUnits(totalExpectedProfit, 6)} USDC`);
        console.log(`📡 Shipping raw batch directly to EVM live pool...`);

        // Broadcast with optimized gas limits
        const tx = await vault.executeFlashBatchArbitrage(payload, { gasLimit: 500000 });
        console.log(`⚡ Tx Broadcasted: ${tx.hash}`);
        await tx.wait();

        // 6. Calculate realized metrics from live state completion
        const balanceAfter = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        const realProfit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;

        console.log("\n=================================================");
        console.log(`🔥 TRADES EXECUTED (DYNAMIC LAYOUT COMPLETED)`);
        console.log(`   CONTRACT BEFORE BALANCE : ${ethers.formatUnits(balanceBefore, 6)} USDC`);
        console.log(`   CONTRACT AFTER BALANCE  : ${ethers.formatUnits(balanceAfter, 6)} USDC`);
        console.log(`   REALIZED PROFIT         : +${ethers.formatUnits(realProfit, 6)} USDC`);
        console.log("=================================================\n");
    } catch (error) {
        const msg = error.reason || error.shortMessage || "Batch yields below minimum threshold / Slippage hit";
        console.log(`❌ BLOCK PASS REVERT: ${msg}\n`);
    }
}

/* ================= RIGOROUSLY GUARDED BOOTSTRAP INITIALIZATION ================= */
async function runEngineSecurely() {
    try {
        console.log("⏳ Initializing system dependencies and verifying credentials...");
        
        if (!PRIVATE_KEY) {
            console.error("❌ CRITICAL BOOT ERROR: Environment variable WALLET_PRIVATE_KEY or PRIVATE_KEY is undefined.");
            process.exit(1);
        }

        // Safe setup rotation
        rotateNetworkProvider();
        
        console.log("🏁 ZERO-REVALIDATION BOT INITIALIZED\n");
        
        const rawRoutes = buildRawTriangularMatrix();
        console.log(`📦 Compiled ${rawRoutes.length} structural market pipelines.`);
        
        while (true) {
            try {
                for (let i = 0; i < rawRoutes.length; i += BATCH_SIZE) {
                    const chunk = rawRoutes.slice(i, i + BATCH_SIZE);
                    await sendRawBatchToContract(chunk);
                }
                await new Promise(resolve => setTimeout(resolve, 100)); // Callstack padding breaker
            } catch (loopError) {
                console.error(`⚠️ Network Loop Exception encountered: ${loopError.message}`);
                rotateNetworkProvider();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    } catch (bootstrapError) {
        console.error("=================================================");
        console.error("❌ UNCAUGHT TOP-LEVEL CRASH DETECTED:");
        console.error(bootstrapError.stack || bootstrapError.message || bootstrapError);
        console.error("=================================================");
        process.exit(1); // Force fail action workflow to avoid silent hang loops
    }
}

// Trigger runtime loop initialization
runEngineSecurely();
