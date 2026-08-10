const { ethers } = require("ethers");

// Standard Minimal ABIs required for off-chain execution & checks
const USDC_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

const ARBITRAGE_CONTRACT_ABI = [
  "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
  "function minimumProfitUSDC() external view returns (uint256)"
];

/**
 * Calculates output with slippage tolerance applied
 * @param {bigint|string} estimatedAmountOut - Amount predicted by router
 * @param {number} maxSlippageBps - Max allowed slippage in Basis Points (50 = 0.5%)
 */
function calculateMinOutput(estimatedAmountOut, maxSlippageBps = 50) {
  const bigIntAmount = BigInt(estimatedAmountOut);
  return (bigIntAmount * BigInt(10000 - maxSlippageBps)) / 10000n;
}

/**
 * Main execution handler enforcing off-chain simulation before broadcasting
 */
async function executeSafeBatchArbitrage({
  provider,
  signer,
  arbitrageContractAddress,
  usdcAddress,
  batchParams
}) {
  const arbitrageContract = new ethers.Contract(
    arbitrageContractAddress,
    ARBITRAGE_CONTRACT_ABI,
    signer
  );

  const usdcContract = new ethers.Contract(
    usdcAddress,
    USDC_ABI,
    provider
  );

  try {
    const contractAddress = await arbitrageContract.getAddress();
    
    // 1. Fetch minimum profit condition & current starting contract balance
    const minProfitUSDC = await arbitrageContract.minimumProfitUSDC();
    const startingBalance = await usdcContract.balanceOf(contractAddress);

    console.log(`[SIMULATION] Starting USDC Balance: ${startingBalance.toString()}`);
    console.log(`[SIMULATION] Minimum Required Net Profit: ${minProfitUSDC.toString()}`);

    // 2. OFF-CHAIN PRE-SIMULATION (eth_call)
    // Runs transaction against current block state without spending gas or broadcasting
    await arbitrageContract.executeFlashBatchArbitrage.staticCall(batchParams);
    console.log("[SIMULATION] staticCall succeeded. Pre-simulation passed.");

    // 3. GAS ESTIMATION
    // Verifies the call completes in the execution environment
    const estimatedGas = await arbitrageContract.executeFlashBatchArbitrage.estimateGas(batchParams);
    console.log(`[SIMULATION] Estimated Gas: ${estimatedGas.toString()}`);

    // Add 20% cushion to estimated gas limit for safety against block state variations
    const safeGasLimit = (BigInt(estimatedGas) * 120n) / 100n;

    // 4. BROADCAST TRANSACTION
    // Executed only if staticCall and estimateGas pass successfully
    console.log("[EXECUTION] Broadcasting batch arbitrage transaction...");
    const tx = await arbitrageContract.executeFlashBatchArbitrage(batchParams, {
      gasLimit: safeGasLimit
    });

    console.log(`[EXECUTION] Tx Sent: ${tx.hash}. Waiting for confirmation...`);
    const receipt = await tx.wait();

    // 5. POST-EXECUTION BALANCE VERIFICATION
    const endingBalance = await usdcContract.balanceOf(contractAddress);
    const netProfit = BigInt(endingBalance) - BigInt(startingBalance);

    if (netProfit < BigInt(minProfitUSDC)) {
      console.warn(
        `[ALERT] Batch completed in block ${receipt.blockNumber}, but realized net profit (${netProfit.toString()}) was under threshold.`
      );
    } else {
      console.log(
        `[SUCCESS] Batch executed in block ${receipt.blockNumber}. Net Profit: ${netProfit.toString()} USDC`
      );
    }

    return receipt;

  } catch (error) {
    // Intercepts simulation errors, slippage deviations, or gas estimation rejections off-chain
    console.error(
      "[SKIPPED] Transaction aborted off-chain. Reason:",
      error.reason || error.message || error
    );
    return null;
  }
}

module.exports = {
  executeSafeBatchArbitrage,
  calculateMinOutput
};
