require("dotenv").config();
const { ethers } = require("ethers");

// =========================
// CONFIG
// =========================

const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Flash loan fee (Aave V3 = 0.09%)
const FLASH_FEE_BPS = 9n; // basis points
const BPS_DIVISOR = 10000n;

// Profit threshold (in wei)
const MIN_PROFIT_WEI = ethers.parseEther("0.00005");

// Binary scaling bounds
const MIN_SCALE = 1n;
const MAX_SCALE = 50n;

// Gas config
const GAS_LIMIT = 300000n;
const GAS_PRICE_GWEI = 30n;

// =========================
// TOKEN CONFIG (EDIT)
// =========================

const TOKENS = {
  WETH: "0xYourWeth",
  USDC: "0xYourUsdc",
  DAI: "0xYourDai"
};

// Multi-hop path restored
const HOP_PATH = [
  TOKENS.WETH,
  TOKENS.USDC,
  TOKENS.DAI,
  TOKENS.WETH
];

// =========================
// ROUTERS
// =========================

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
];

const ROUTERS = {
  UNI: new ethers.Contract("0xUniswapRouter", routerAbi, provider),
  SUSHI: new ethers.Contract("0xSushiRouter", routerAbi, provider)
};

// =========================
// UTILITY
// =========================

function format(num) {
  return Number(ethers.formatEther(num)).toFixed(6);
}

function flashFee(amount) {
  return (amount * FLASH_FEE_BPS) / BPS_DIVISOR;
}

function gasCostWei() {
  return GAS_LIMIT * (GAS_PRICE_GWEI * 1_000_000_000n);
}

// =========================
// SIMULATION
// =========================

async function simulateArb(amountInWei) {

  try {

    // Hop 1
    const out1 = await ROUTERS.UNI.getAmountsOut(
      amountInWei,
      [HOP_PATH[0], HOP_PATH[1]]
    );

    // Hop 2
    const out2 = await ROUTERS.SUSHI.getAmountsOut(
      out1[1],
      [HOP_PATH[1], HOP_PATH[2]]
    );

    // Hop 3
    const out3 = await ROUTERS.UNI.getAmountsOut(
      out2[1],
      [HOP_PATH[2], HOP_PATH[3]]
    );

    const finalAmount = out3[1];

    const fee = flashFee(amountInWei);
    const gas = gasCostWei();

    const profit = finalAmount - amountInWei - fee - gas;

    return profit;

  } catch (err) {
    return -1n;
  }
}

// =========================
// BINARY SEARCH SCALING
// =========================

async function binaryScale(baseAmountWei) {

  let low = MIN_SCALE;
  let high = MAX_SCALE;

  let bestProfit = 0n;
  let bestSize = 0n;

  while (low <= high) {

    const mid = (low + high) / 2n;
    const testAmount = baseAmountWei * mid;

    const profit = await simulateArb(testAmount);

    console.log(
      `Scale x${mid} | Size: ${format(testAmount)} | Profit: ${format(profit)}`
    );

    if (profit > MIN_PROFIT_WEI) {
      bestProfit = profit;
      bestSize = testAmount;
      low = mid + 1n;
    } else {
      high = mid - 1n;
    }
  }

  return { bestProfit, bestSize };
}

// =========================
// MAIN LOOP
// =========================

async function run() {

  console.log("=================================");
  console.log("Scanning for arbitrage...");
  console.log("=================================");

  const baseAmountWei = ethers.parseEther("0.02");

  const microProfit = await simulateArb(baseAmountWei);

  console.log("Micro size:", format(baseAmountWei));
  console.log("Micro profit:", format(microProfit));

  if (microProfit <= MIN_PROFIT_WEI) {
    console.log("No micro opportunity.");
    return;
  }

  console.log("Micro profitable → Starting binary scaling...");
  console.log("---------------------------------");

  const { bestProfit, bestSize } = await binaryScale(baseAmountWei);

  console.log("---------------------------------");

  if (bestProfit > MIN_PROFIT_WEI) {

    console.log("✓ PROFITABLE SIZE FOUND");
    console.log("Final size:", format(bestSize));
    console.log("Expected profit:", format(bestProfit));
    console.log("Ready for execution.");

  } else {

    console.log("No profitable scaled size.");
  }

  console.log("=================================");
}

run();
