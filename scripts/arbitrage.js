import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config({ override: false });

/* ================= CREDENTIALS VALIDATION ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error("❌ CRITICAL: Private key missing from environment variables.");
    process.exit(1);
}

/* ================= HIGH-PERFORMANCE RPC POOL ================= */
// RECOMMENDED: Replace the public endpoint below with a private Alchemy or QuickNode URL
const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
];
let rpcIndex = 0;

/* ================= BOT CONFIGURATION (FIXED) ================= */
const MIN_MULTIPLIER_SIZE = ethers.parseUnits(".05", 6);  // Raised to $10.00 USDC to bypass AMM fee friction
const MULTIPLIER_STEPS = 5;                               // Number of candidate steps to test off-chain
const BATCH_SIZE = 1;                                     // Reduced to 1 to execute individual profitable paths immediately
const DESIRED_PREMIUM = ethers.parseUnits("0.00", 6);     // Set to $0.00 initially to target pure gas clearing
const MIN_PROFIT_PER_TRADE = ethers.parseUnits("0.001", 6); // Dust mitigation threshold

/* ================= CORE CONTRACT TARGETS ================= */
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

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
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
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

/* ================= BUILD RECURSIVE CROSS-ROUTE MATRIX ================= */
function buildRawTriangularMatrix() {
    const routersList = Object.values(routers);
    const rawBatches = [];
    const intermediateTokens = Object.values(TOKENS);

    for (const router of routersList) {
        for (const tokenA of intermediateTokens) {
            for (const tokenB of intermediateTokens) {
                if (tokenA === tokenB) continue;
                
                rawBatches.push({
                    buyRouter: router,
                    sellRouter: router,
                    amountInUSDC: MIN_MULTIPLIER_SIZE,
                    pathToToken: [USDC, tokenA, tokenB],
                    pathToUSDC: [tokenB, USDT, USDC]
                });
                
                if (rawBatches.length >= 80) break;
            }
            if (rawBatches.length >= 80) break;
        }
        if (rawBatches.length >= 80) break;
    }
    return rawBatches;
}

/* ================= REAL-TIME GAS CONVERSION MATHEMATICAL ENGINE ================= */
async function calculateDynamicProfitFloor(payload, targetPremiumUSDC) {
    try {
        const feeData = await provider.getFeeData();
        
        // Dynamic pricing with safety floor for competitive execution
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("35", 9);
        const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits("200", 9);

        // Estimate raw gas consumption via static simulation
        const estimatedGasUnits = await vault.executeFlashBatchArbitrage.estimateGas(payload)
            .catch(() => 350000n); // Baseline execution buffer fallback

        const totalGasCostInWei = estimatedGasUnits * maxFeePerGas;

        // Convert WMATIC Gas Fees into USDC value via QuickSwap
        const quickswapRouter = new ethers.Contract(routers.QuickSwap, routerAbi, provider);
        const conversionAmounts = await quickswapRouter.getAmountsOut(totalGasCostInWei, [TOKENS.WMATIC, USDC])
            .catch(() => [totalGasCostInWei, ethers.parseUnits("0.05", 6)]); // Safe fallback proxy fee

        const gasCostInUSDC = conversionAmounts[conversionAmounts.length - 1];
        const totalRequiredProfitFloor = gasCostInUSDC + targetPremiumUSDC;

        return {
            gasCostInUSDC,
            totalRequiredProfitFloor,
            estimatedGasUnits,
            maxPriorityFeePerGas,
            maxFeePerGas
        };
    } catch (err) {
        return {
            gasCostInUSDC: ethers.parseUnits("0.05", 6),
            totalRequiredProfitFloor: ethers.parseUnits("0.05", 6) + targetPremiumUSDC,
            estimatedGasUnits: 350000n,
            maxPriorityFeePerGas: ethers.parseUnits("40", 9),
            maxFeePerGas: ethers.parseUnits("250", 9)
        };
    }
}

/* ================= HIGH-SPEED ARBITRAGE SCANNER & EXECUTION PASS ================= */
async function sendRawBatchToContract(trades) {
    const deadline = Math.floor(Date.now() / 1000) + 120;

    try {
        const balanceBefore = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        
        // Safety Warning: Let operator know if the contract itself has zero working funds
        if (balanceBefore < MIN_MULTIPLIER_SIZE) {
            console.log(`⚠️  SKIPPED PASS: Contract balance (${ethers.formatUnits(balanceBefore, 6)} USDC) is less than MIN_MULTIPLIER_SIZE.`);
            return;
        }

        // 1. Calculate Multiplier Steps Array Based On Contract Vault Pool Sizes
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

        let optimizedBatchTrades = [];
        let totalExpectedProfit = 0n;
        let batchValid = true;

        // 2. Off-chain Simulation Search Pass
        for (let i = 0; i < trades.length; i++) {
            const trade = trades[i];
            let bestTradeProfit = 0n;
            let optimalSizeForRoute = MIN_MULTIPLIER_SIZE;

            try {
                const routerContract = new ethers.Contract(trade.buyRouter, routerAbi, provider);
                
                for (const candidateSize of dynamicCandidates) {
                    const buyAmounts = await routerContract.getAmountsOut(candidateSize, trade.pathToToken);
                    const tokenBAmount = buyAmounts[buyAmounts.length - 1];
                    
                    const sellAmounts = await routerContract.getAmountsOut(tokenBAmount, trade.pathToUSDC);
                    const finalUSDC = sellAmounts[sellAmounts.length - 1];
                    
                    const tradeProfit = finalUSDC > candidateSize ? (finalUSDC - candidateSize) : 0n;
                    
                    if (tradeProfit > bestTradeProfit) {
                        bestTradeProfit = tradeProfit;
                        optimalSizeForRoute = candidateSize;
                    }
                }

                if (bestTradeProfit < MIN_PROFIT_PER_TRADE) {
                    batchValid = false;
                    break; 
                }

                totalExpectedProfit += bestTradeProfit;
                optimizedBatchTrades.push({
                    ...trade,
                    calculatedOptimalSize: optimalSizeForRoute,
                    assignedProfit: bestTradeProfit
                });

            } catch (err) {
                batchValid = false;
                break;
            }
        }

        if (!batchValid || optimizedBatchTrades.length !== trades.length) return;

        // 3. Structural Setup Payload for Gas Cost Analysis
        const payload = {
            buyRouters: optimizedBatchTrades.map(t => t.buyRouter),
            sellRouters: optimizedBatchTrades.map(t => t.sellRouter),
            amountsInUSDC: optimizedBatchTrades.map(t => t.calculatedOptimalSize),
            pathsToToken: optimizedBatchTrades.map(t => t.pathToToken),
            pathsToUSDC: optimizedBatchTrades.map(t => t.pathToUSDC),
            deadline: deadline
        };

        // 4. Run Real-Time Cost Analysis Execution Pass
        const metrics = await calculateDynamicProfitFloor(payload, DESIRED_PREMIUM);

        console.log(`⛽ Real-Time Cost Analysis:`);
        console.log(`   Estimated Network Gas Cost : $${ethers.formatUnits(metrics.gasCostInUSDC, 6)} USDC`);
        console.log(`   Target Net Profit Premium  : $${ethers.formatUnits(DESIRED_PREMIUM, 6)} USDC`);
        console.log(`   Absolute Batch Profit Floor: $${ethers.formatUnits(metrics.totalRequiredProfitFloor, 6)} USDC\n`);

        console.log(`🔍 [SIMULATION] Testing batch of ${trades.length} routes against exact block state...`);
        
        for(let i=0; i<optimizedBatchTrades.length; i++) {
             console.log(`🔥 ROUTE OPTIMIZED: Trade #${i+1} found peak returns at multiplier size: ${ethers.formatUnits(optimizedBatchTrades[i].calculatedOptimalSize, 6)} USDC (Expected Profit: +${ethers.formatUnits(optimizedBatchTrades[i].assignedProfit, 6)} USDC)`);
        }

        // 5. Evaluate Simulation Returns Against Dynamic Profit Floor Anchor
        if (totalExpectedProfit < metrics.totalRequiredProfitFloor) {
            console.log(`⚠️ BATCH REJECTED: Total Expected Return fails to clear absolute floor.`);
            return;
        }

        console.log(`🔥 SIMULATION SUCCESSFUL: Total Expected Return (+${ethers.formatUnits(totalExpectedProfit, 6)} USDC) clears absolute floor ($${ethers.formatUnits(metrics.totalRequiredProfitFloor, 6)} USDC).\n`);
        console.log(`📡 Shipping raw batch directly to EVM live pool...`);

        // Static Call Pre-flight Validation Guard
        await vault.executeFlashBatchArbitrage.staticCall(payload);

        // 6. Broadcast to EVM Live Pool using hardcoded EIP-1559 Parameters
        const gasBufferLimit = (metrics.estimatedGasUnits * 130n) / 100n; // 30% safety window
        const tx = await vault.executeFlashBatchArbitrage(payload, { 
            gasLimit: gasBufferLimit,
            maxPriorityFeePerGas: metrics.maxPriorityFeePerGas,
            maxFeePerGas: metrics.maxFeePerGas
        });
        console.log(`⚡ Tx Broadcasted: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log(`🎉 TX MINED IN BLOCK #${receipt.blockNumber} (Gas Used: ${receipt.gasUsed?.toLocaleString()})`);

        // 7. Extract Final Realized Balances
        const balanceAfter = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        const realGrossReturn = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
        const estimatedNetPremium = realGrossReturn > metrics.gasCostInUSDC ? realGrossReturn - metrics.gasCostInUSDC : 0n;

        console.log("\n=================================================");
        console.log(`🔥 TRADES EXECUTED (DYNAMIC NET REVENUE CAPTURE)`);
        console.log(`   CONTRACT BEFORE BALANCE : ${ethers.formatUnits(balanceBefore, 6)} USDC`);
        console.log(`   CONTRACT AFTER BALANCE  : ${ethers.formatUnits(balanceAfter, 6)} USDC`);
        console.log(`   REALIZED GROSS RETURN   : +${ethers.formatUnits(realGrossReturn, 6)} USDC`);
        console.log(`   ESTIMATED NET PREMIUM   : +${ethers.formatUnits(estimatedNetPremium, 6)} USDC (After Network Gas Deductions)`);
        console.log("=================================================\n");

    } catch (error) {
        console.log(`❌ BLOCK PASS REVERT: ${error.reason || error.shortMessage || "Transaction execution failed during pre-flight estimation"}\n`);
    }
}

/* ================= SECURE RUNTIME WRAPPER ================= */
async function runEngineSecurely() {
    try {
        rotateNetworkProvider();
        console.log("🏁 ZERO-REVALIDATION BOT INITIALIZED FOR JS2");
        
        const rawRoutes = buildRawTriangularMatrix();
        console.log(`📦 Compiled ${rawRoutes.length} structural market pipelines.\n`);
        
        while (true) {
            for (let i = 0; i < rawRoutes.length; i += BATCH_SIZE) {
                const chunk = rawRoutes.slice(i, i + BATCH_SIZE);
                await sendRawBatchToContract(chunk);
            }
            // 500ms safety rate throttling to respect RPC query rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } catch (err) {
        console.error("Fatal engine error encountered:", err);
        process.exit(1);
    }
}

runEngineSecurely();
