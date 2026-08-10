import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ==========================================================================
   CONFIGURATIONS & CONSTANTS
   ========================================================================== */

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000000";

const ARBITRAGE_CONTRACT_ADDRESS = "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

const WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const WBTC_ADDRESS = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";

const SCAN_INTERVAL_MS = 3000;

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
   EXECUTION ENGINE
   ========================================================================== */

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
    const minProfitUSDC = await arbitrageContract.minimumProfitUSDC();
    const startingBalance = await usdcContract.balanceOf(contractAddress);

    // OFF-CHAIN PRE-SIMULATION (eth_call)
    await arbitrageContract.executeFlashBatchArbitrage.staticCall(batchParams);

    const formattedStartingBal = ethers.formatUnits(startingBalance, 6);
    const formattedMinProfit = ethers.formatUnits(minProfitUSDC, 6);

    console.log(`\n=================== 📊 TRADE ATTEMPT 📊 ===================`);
    console.log(`📍 Contract Address : ${contractAddress}`);
    console.log(`💰 Starting Balance : 💵 ${formattedStartingBal} USDC`);
    console.log(`🎯 Min Required Profit: 💵 ${formattedMinProfit} USDC`);
    console.log("✅ Simulation Passed! Route is executable.");

    const estimatedGas = await arbitrageContract.executeFlashBatchArbitrage.estimateGas(batchParams);
    const safeGasLimit = (BigInt(estimatedGas) * 120n) / 100n;
    console.log(`⛽ Estimated Gas    : ${estimatedGas.toString()} (Limit: ${safeGasLimit.toString()})`);

    console.log("🚀 Broadcasting Arbitrage Batch to Mempool...");
    const tx = await arbitrageContract.executeFlashBatchArbitrage(batchParams, {
      gasLimit: safeGasLimit
    });

    console.log(`🔗 Tx Hash          : ${tx.hash}`);
    console.log("⏳ Waiting for block confirmation...");
    const receipt = await tx.wait();

    // POST-EXECUTION VERIFICATION
    const endingBalance = await usdcContract.balanceOf(contractAddress);
    const netProfitUnits = BigInt(endingBalance) - BigInt(startingBalance);

    const formattedEndingBal = ethers.formatUnits(endingBalance, 6);
    const formattedNetProfit = ethers.formatUnits(netProfitUnits, 6);

    console.log(`\n=================== 📈 RESULTS 📈 ===================`);
    console.log(`🏦 Ending Balance   : 💵 ${formattedEndingBal} USDC`);

    if (netProfitUnits < BigInt(minProfitUSDC)) {
      console.log(`⚠️  Status           : 🔴 UNPROFITABLE / ZERO PROFIT`);
      console.log(`📉 Net Realized     : 💸 ${formattedNetProfit} USDC (Block #${receipt.blockNumber})`);
    } else {
      console.log(`🎉 Status           : 🟢 PROFITABLE BATCH EXECUTED`);
      console.log(`🚀 Net Realized     : 🤑 +${formattedNetProfit} USDC (Block #${receipt.blockNumber})`);
    }
    console.log(`======================================================\n`);

    return receipt;

  } catch (error) {
    // Silently skip routes that are unprofitable or revert off-chain during simulation
    return null;
  }
}

/* ==========================================================================
   CONTINUOUS SCANNING ENTRY POINT
   ========================================================================== */

async function startContinuousScanner() {
  console.log("🤖 =================================================== 🤖");
  console.log("🚀       ARBBOT1 CONTINUOUS SCANNER STARTED          🚀");
  console.log("🤖 =================================================== 🤖\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  let scanCount = 0;

  while (true) {
    scanCount++;
    try {
      const currentBlock = await provider.getBlock("latest");
      const deadline = BigInt(currentBlock.timestamp + 300);

      console.log(`🔍 [Scan #${scanCount}] Checking opportunities on Block #${currentBlock.number}...`);

      const batchParams = {
        buyRouters: [QUICKSWAP_ROUTER, SUSHI_ROUTER],
        sellRouters: [SUSHI_ROUTER, QUICKSWAP_ROUTER],
        amountsInUSDC: [
          ethers.parseUnits("10", 6),
          ethers.parseUnits("10", 6)
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

      await executeSafeBatchArbitrage(provider, signer, batchParams);

    } catch (err) {
      console.error(`❌ [Scan #${scanCount}] Error during cycle:`, err.message || err);
    }

    await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
  }
}

startContinuousScanner().catch((err) => {
  console.error("💥 [FATAL SCANNER ERROR]", err);
  process.exit(1);
});
