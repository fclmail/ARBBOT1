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
const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
];
let rpcIndex = 0;

/* ================= FORCED VERIFICATION CONFIGURATION ================= */
const FIXED_TEST_LOAN_SIZE = ethers.parseUnits("0.05", 6); // Set a small flash loan size to test the pipe safely
const DESIRED_PREMIUM = ethers.parseUnits("0.00", 6);     

/* ================= CORE CONTRACT TARGETS ================= */
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory amounts)"];

// ABI matched directly to your contract's specific Flash Loan entry point
const contractAbi = [
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() view returns (uint256)",
    "function aavePoolAddress() view returns (address)"
];

/* ================= DEX ROUTERS MATRIX ================= */
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

/* ================= CROSS-TOKEN ROUTE MATRIX ================= */
const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
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

/* ================= REAL-TIME GAS CONVERSION MATHEMATICAL ENGINE ================= */
async function calculateDynamicProfitFloor(buyRouter, sellRouter, pathToToken, pathToUSDC, deadline) {
    try {
        const feeData = await provider.getFeeData();
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("35", 9);
        const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits("220", 9);

        // Estimate raw gas consumption via static simulation of the flash loan function
        const estimatedGasUnits = await vault.executeAaveFlashLoanArbitrage.estimateGas(
            buyRouter, sellRouter, FIXED_TEST_LOAN_SIZE, pathToToken, pathToUSDC, deadline
        ).catch(() => 550000n); // Flash loans require more execution gas than standard pools (~550k)

        const totalGasCostInWei = estimatedGasUnits * maxFeePerGas;

        const quickswapRouter = new ethers.Contract(routers.QuickSwap, routerAbi, provider);
        const conversionAmounts = await quickswapRouter.getAmountsOut(totalGasCostInWei, [TOKENS.WMATIC, USDC])
            .catch(() => [totalGasCostInWei, ethers.parseUnits("0.05", 6)]); 

        const gasCostInUSDC = conversionAmounts[conversionAmounts.length - 1];
        const totalRequiredProfitFloor = gasCostInUSDC + DESIRED_PREMIUM;

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
            totalRequiredProfitFloor: ethers.parseUnits("0.05", 6),
            estimatedGasUnits: 550000n,
            maxPriorityFeePerGas: ethers.parseUnits("40", 9),
            maxFeePerGas: ethers.parseUnits("250", 9)
        };
    }
}

/* ================= FLASH LOAN EXECUTION PIPE ================= */
async function triggerFlashLoanPipeline() {
    const deadline = Math.floor(Date.now() / 1000) + 120;

    try {
        // Confirm contract holds capital to satisfy the flash loan premium fee checks
        const balanceBefore = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        console.log(`🏦 Contract Vault Balance: ${ethers.formatUnits(balanceBefore, 6)} USDC`);

        // Check the contract's set minimumProfitUSDC requirement
        const contractMinProfitSetting = await vault.minimumProfitUSDC();
        console.log(`🛡️ Contract minimumProfitUSDC state requirement: ${ethers.formatUnits(contractMinProfitSetting, 6)} USDC`);
        
        if (contractMinProfitSetting > 0n) {
            console.log("⚠️ WARNING: Your contract requires positive profit. If the transaction reverts inside executeOperation, you must set minimumProfitUSDC to 0 inside your contract for micro-testing.");
        }

        // Setup a standard verification route (USDC -> WMATIC -> WETH -> USDT -> USDC)
        const buyRouter = routers.QuickSwap;
        const sellRouter = routers.QuickSwap;
        const pathToToken = [USDC, TOKENS.WMATIC, TOKENS.WETH];
        const pathToUSDC = [TOKENS.WETH, USDT, USDC];

        console.log(`📡 Simulating off-chain route liquidity at fixed loan size: ${ethers.formatUnits(FIXED_TEST_LOAN_SIZE, 6)} USDC`);

        // Gas & network price evaluation pass
        const metrics = await calculateDynamicProfitFloor(buyRouter, sellRouter, pathToToken, pathToUSDC, deadline);

        console.log(`⛽ Real-Time Cost Analysis:`);
        console.log(`   Estimated Network Gas Cost : $${ethers.formatUnits(metrics.gasCostInUSDC, 6)} USDC`);
        console.log(`   Requested Flash Loan Capital: $${ethers.formatUnits(FIXED_TEST_LOAN_SIZE, 6)} USDC\n`);

        console.log(`🔥 SIMULATION BYPASS FORCE: Executing Aave Flash Loan pipeline verification pass...`);
        console.log(`📡 Shipping execution transaction directly to EVM live pool...`);

        // Note: staticCall might revert if Aave detects your contract lacks permissions or if pool spreads error out.
        // We catch it gracefully to guarantee execution dispatch.
        await vault.executeAaveFlashLoanArbitrage.staticCall(
            buyRouter, sellRouter, FIXED_TEST_LOAN_SIZE, pathToToken, pathToUSDC, deadline
        ).catch((err) => console.log("ℹ️ Static call estimation bypassed or returned a structural pool variation. Forcing broadcast."));

        // Broadcast directly to live mempool using hardcoded EIP-1559 Parameters
        const gasBufferLimit = (metrics.estimatedGasUnits * 130n) / 100n; 
        const tx = await vault.executeAaveFlashLoanArbitrage(
            buyRouter, sellRouter, FIXED_TEST_LOAN_SIZE, pathToToken, pathToUSDC, deadline, 
            { 
                gasLimit: gasBufferLimit,
                maxPriorityFeePerGas: metrics.maxPriorityFeePerGas,
                maxFeePerGas: metrics.maxFeePerGas
            }
        );
        console.log(`⚡ Tx Broadcasted: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log(`🎉 FLASH LOAN TX MINED IN BLOCK #${receipt.blockNumber} (Gas Used: ${receipt.gasUsed?.toLocaleString()})`);

        // Extract Final Realized Balances
        const balanceAfter = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        console.log("\n=================================================");
        console.log(`🔥 FLASH LOAN PIPELINE VERIFICATION COMPLETE`);
        console.log(`   CONTRACT BEFORE BALANCE : ${ethers.formatUnits(balanceBefore, 6)} USDC`);
        console.log(`   CONTRACT AFTER BALANCE  : ${ethers.formatUnits(balanceAfter, 6)} USDC`);
        console.log("=================================================\n");

        console.log("✅ Flash loan pipeline verified successfully. Exiting safely.");
        process.exit(0);

    } catch (error) {
        console.log(`❌ BLOCK PASS REVERT: ${error.reason || error.shortMessage || "Transaction execution failed during flash loan callback setup."}`);
        console.log("Check if your deployer wallet contains MATIC/POL for gas fees.");
        process.exit(1);
    }
}

/* ================= SECURE RUNTIME WRAPPER ================= */
async function runEngineSecurely() {
    try {
        rotateNetworkProvider();
        console.log("🏁 ZERO-REVALIDATION FLASH LOAN TESTER INITIALIZED");
        await triggerFlashLoanPipeline();
    } catch (err) {
        console.error("Fatal engine error encountered:", err);
        process.exit(1);
    }
}

runEngineSecurely();
