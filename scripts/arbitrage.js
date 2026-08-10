import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ==========================================================================
   CONFIGURATIONS & CONSTANTS
   ========================================================================== */

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000000";

// Target Contracts & Addresses
const ARBITRAGE_CONTRACT_ADDRESS = "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// DEX Routers
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

// Target Tokens
const WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const WBTC_ADDRESS = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";

/* ==========================================================================
   ABIs
   ========================================================================== */

const USDC_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

const ARBITRAGE_CONTRACT_ABI = [
  "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
  "function minimumProfitUSDC() external view returns (uint256)"
];

/* ==========================================================================
   HELPER FUNCTIONS
   ========================================================================== */

/**
 * Calculates output with slippage tolerance applied
 * @param {bigint|string} estimatedAmountOut - Amount predicted by router
 * @param {number} maxSlippageBps - Max allowed slippage in Basis Points (50 = 0.5%)
 */
export function calculateMinOutput(estimatedAmountOut, maxSlippageBps = 50) {
  const bigIntAmount = BigInt(estimatedAmountOut);
  return (bigIntAmount * BigInt(10000 - maxSlippageBps)) / 10000n;
}

/* ==========================================================================
   MAIN EXECUTION ENGINE
   ========================================================================== */

/**
 * Validates, simulates via staticCall, and executes flash batch arbitrage transactions.
 */
export async function executeSafeBatchArbitrage(provider, signer, batchParams) {
  const arbitrageContract = new ethers.Contract(
    ARBITRAGE_CONTRACT_ADDRESS,
    ARBITRAGE_CONTRACT_ABI,
    signer
  );

  const usdcContract = new ethers.Contract(
    USDC_ADDRESS,
    USDC_ABI,
    provider
  );

  try {
    const contractAddress = await arbitrageContract.getAddress();

    // 1. Fetch current on-chain state parameters
    const minProfitUSDC = await arbitrageContract.minimumProfitUSDC();
    const startingBalance = await usdcContract.balanceOf(contractAddress);

    console.log(`[STATE] Contract Address: ${contractAddress}`);
    console.log(`[STATE] Starting Balance: ${startingBalance.toString()} USDC units`);
    console.log(`[STATE] Min Required Profit: ${minProfitUSDC.toString()} USDC units`);

    // 2. OFF-CHAIN PRE-SIMULATION (eth_call)
    // Prevents sending unprofitable or failing transactions to the network
    console.log("[SIMULATION] Running off-chain staticCall pre-simulation...");
    await arbitrageContract.executeFlashBatchArbitrage.staticCall(batchParams);
    console.log("[SIMULATION] Success: Off-chain simulation passed without reverts.");

    // 3. GAS ESTIMATION & BUFFERING
    console.log("[GAS] Estimating required gas units...");
    const estimatedGas = await arbitrageContract.executeFlashBatchArbitrage.estimateGas(batchParams);
    console.log(`[GAS] Estimated Units: ${estimatedGas.toString()}`);

    // Add 20% safety buffer for gas limits against state shifts
    const safeGasLimit = (BigInt(estimatedGas) * 120n) / 100n;

    // 4. BROADCAST TRANSACTION
    console.log("[EXECUTION] Broadcasting transaction...");
    const tx = await arbitrageContract.executeFlashBatchArbitrage(batchParams, {
      gasLimit: safeGasLimit
    });

    console.log(`[EXECUTION] Transaction Hash: ${tx.hash}`);
    console.log("[EXECUTION] Waiting for block inclusion...");
    
    const receipt = await tx.wait();

    // 5. POST-EXECUTION VERIFICATION
    const endingBalance = await usdcContract.balanceOf(contractAddress);
    const netProfit = BigInt(endingBalance) - BigInt(startingBalance);

    if (netProfit < BigInt(minProfitUSDC)) {
      console.warn(
        `[WARNING] Batch included in block ${receipt.blockNumber}, but net profit (${netProfit.toString()}) fell below minimum required threshold.`
      );
    } else {
      console.log(
        `[SUCCESS] Batch executed in block ${receipt.blockNumber}. Net Realized Profit: ${netProfit.toString()} USDC units.`
      );
    }

    return receipt;

  } catch (error) {
    // Intercepts simulation errors, slippage failures, or gas estimation rejections off-chain
    console.error(
      "[SKIPPED] Batch execution aborted off-chain. Reason:",
      error.reason || error.message || error
    );
    return null;
  }
}

/* ==========================================================================
   ENTRY POINT
   ========================================================================== */

async function main() {
  console.log("[INIT] Initializing Provider and Signer...");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  const currentBlock = await provider.getBlock("latest");
  const deadline = BigInt(currentBlock.timestamp + 300); // 5-minute deadline

  const batchParams = {
    buyRouters: [QUICKSWAP_ROUTER, SUSHI_ROUTER],
    sellRouters: [SUSHI_ROUTER, QUICKSWAP_ROUTER],
    amountsInUSDC: [
      ethers.parseUnits("10", 6), // 10 USDC
      ethers.parseUnits("10", 6)  // 10 USDC
    ],
    pathsToToken: [
      [USDC_ADDRESS, WETH_ADDRESS],
      [USDC_ADDRESS, WBTC_ADDRESS]
    ],
    pathsToUSDC: [
      [WETH_ADDRESS, USDC_ADDRESS],
      [WBTC_ADDRESS, USDC_ADDRESS]
    ],
    deadline: deadline
  };

  console.log("[MAIN] Starting Safe Arbitrage Execution Cycle...");
  await executeSafeBatchArbitrage(provider, signer, batchParams);
}

main().catch((err) => {
  console.error("[FATAL ERROR]", err);
  process.exit(1);
});
