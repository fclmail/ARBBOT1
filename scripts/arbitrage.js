import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ==========================================================================
   CONFIGURATIONS & PARAMETERS (ADJUSTABLE)
   ========================================================================== */

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000000";

const ARBITRAGE_CONTRACT_ADDRESS = process.env.ARBITRAGE_CONTRACT_ADDRESS || "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Adjustable Bot Controls
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 3000;
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 6;                   // Max trades per batch
const TRADE_AMOUNT_USDC = process.env.TRADE_AMOUNT_USDC || "10.0";       // Base USDC per trade route
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC || "0.01";            // Minimum required net profit

/* ==========================================================================
   RESTORED TOKEN & ROUTER REGISTRY
   ========================================================================== */

const ROUTERS = {
  QUICKSWAP: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SUSHISWAP: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  APESWAP: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1B6ce",
  WAULTSWAP: "0x3a1D87f206D12415f5b0A33E786967680AAb4f6d"
};

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  LINK: "0x53E0bca35eC356BD5ddCebbD1A426DA59207416f",
  AAVE: "0xD6DF9B7222728C3A09769Ce681c9117D237D6193",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  QUICK: "0x831753DD7087CaC61aB5644b308642cc1c33dc13",
  GHST: "0x383293710E934C51896582d6d8312014603B6373"
};

/* ==========================================================================
   PREDEFINED MULTI-HOP PATH PRESETS
   ========================================================================== */

const HOP_PATH_PRESETS = [
  // 2-Hop Direct Paths (USDC -> Target -> USDC)
  {
    toToken: [USDC_ADDRESS, TOKENS.WETH],
    toUSDC: [TOKENS.WETH, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.WBTC],
    toUSDC: [TOKENS.WBTC, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.WMATIC],
    toUSDC: [TOKENS.WMATIC, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.LINK],
    toUSDC: [TOKENS.LINK, USDC_ADDRESS]
  },
  // 3-Hop Triangular Paths (USDC -> Intermediary -> Target -> USDC)
  {
    toToken: [USDC_ADDRESS, TOKENS.WMATIC, TOKENS.WETH],
    toUSDC: [TOKENS.WETH, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.WETH],
    toUSDC: [TOKENS.WETH, TOKENS.WBTC, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.USDT, TOKENS.WMATIC],
    toUSDC: [TOKENS.WMATIC, TOKENS.DAI, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.QUICK],
    toUSDC: [TOKENS.QUICK, TOKENS.WETH, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.WMATIC, TOKENS.AAVE],
    toUSDC: [TOKENS.AAVE, USDC_ADDRESS]
  },
  {
    toToken: [USDC_ADDRESS, TOKENS.GHST],
    toUSDC: [TOKENS.GHST, TOKENS.WMATIC, USDC_ADDRESS]
  }
];

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
   BATCH BUILDER WITH MULTI-HOP PATHS
   ========================================================================== */

function generateBatchParameters(deadline) {
  const buyRoutersList = [ROUTERS.QUICKSWAP, ROUTERS.SUSHISWAP, ROUTERS.APESWAP];
  const sellRoutersList = [ROUTERS.SUSHISWAP, ROUTERS.QUICKSWAP, ROUTERS.WAULTSWAP];

  const buyRouters = [];
  const sellRouters = [];
  const amountsInUSDC = [];
  const pathsToToken = [];
  const pathsToUSDC = [];

  const tradeAmountUnits = ethers.parseUnits(TRADE_AMOUNT_USDC, 6);

  for (let i = 0; i < Math.min(BATCH_SIZE, HOP_PATH_PRESETS.length); i++) {
    const preset = HOP_PATH_PRESETS[i % HOP_PATH_PRESETS.length];
    const buyRouter = buyRoutersList[i % buyRoutersList.length];
    const sellRouter = sellRoutersList[i % sellRoutersList.length];

    buyRouters.push(buyRouter);
    sellRouters.push(sellRouter);
    amountsInUSDC.push(tradeAmountUnits);
    pathsToToken.push(preset.toToken);
    pathsToUSDC.push(preset.toUSDC);
  }

  return {
    buyRouters,
    sellRouters,
    amountsInUSDC,
    pathsToToken,
    pathsToUSDC,
    deadline
  };
}

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
    const minProfitContract = await arbitrageContract.minimumProfitUSDC();
    const startingBalance = await usdcContract.balanceOf(contractAddress);

    // OFF-CHAIN PRE-SIMULATION (eth_call)
    await arbitrageContract.executeFlashBatchArbitrage.staticCall(batchParams);

    const formattedStartingBal = ethers.formatUnits(startingBalance, 6);
    const formattedMinProfit = ethers.formatUnits(minProfitContract, 6);

    console.log(`\n=================== 📊 TRADE ATTEMPT 📊 ===================`);
    console.log(`📍 Contract Address : ${contractAddress}`);
    console.log(`💰 Starting Balance : 💵 ${formattedStartingBal} USDC`);
    console.log(`🎯 Min Required Profit: 💵 ${formattedMinProfit} USDC`);
    console.log(`📦 Batch Size Target: ${batchParams.buyRouters.length} routes (Multi-Hop active)`);
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

    if (netProfitUnits < BigInt(minProfitContract)) {
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
  console.log(`⚙️  Batch Size: ${BATCH_SIZE} | Trade Amount: ${TRADE_AMOUNT_USDC} USDC | Min Profit: ${MIN_PROFIT_USDC} USDC`);
  console.log("🤖 =================================================== 🤖\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  let scanCount = 0;

  while (true) {
    scanCount++;
    try {
      const currentBlock = await provider.getBlock("latest");
      const deadline = BigInt(currentBlock.timestamp + 300);

      console.log(`🔍 [Scan #${scanCount}] Checking multi-hop opportunities on Block #${currentBlock.number}...`);

      const batchParams = generateBatchParameters(deadline);
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
