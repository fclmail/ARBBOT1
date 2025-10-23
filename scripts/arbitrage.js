// scripts/arbitrage.js
// Node 20+ compatible ESM script
import { ethers } from "ethers";

// === CONFIGURATION ===

// Hardcoded contract + key tokens
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // Polygon mainnet
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Replace with your token address (currently using USDT example)
const TOKEN = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"; // USDT on Polygon

// Routers (example: SushiSwap + QuickSwap)
const ROUTER_A = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"; // SushiSwap
const ROUTER_B = "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap

// Trade and profit thresholds
const TRADE_AMOUNT_USDC = "100"; // USD value per scan
const MIN_PROFIT_USDC = "0.000001"; // profit threshold (USD)

// RPC and wallet (read-only simulation)
const RPC_URL = "https://polygon-rpc.com"; // Public Polygon RPC
const provider = new ethers.JsonRpcProvider(RPC_URL);

// === TOKEN LIST (optional reference for decimals) ===
const TOKENS = {
  USDC: { address: USDC, decimals: 6 },
  USDT: { address: TOKEN, decimals: 6 },
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
};

// === CONTRACT ABI (for simulation only) ===
const AaveFlashArbABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
];

// === INITIALIZATION ===
async function init() {
  console.log(`🔗 Using contract: ${CONTRACT_ADDRESS}`);
  console.log(`🔧 Provider: Polygon RPC`);

  const tokenInfo = Object.values(TOKENS).find(
    (t) => t.address.toLowerCase() === TOKEN.toLowerCase()
  );
  if (!tokenInfo) {
    console.error(`❌ Token ${TOKEN} not found in TOKENS list`);
    process.exit(1);
  }

  const USDC_DECIMALS = TOKENS.USDC.decimals;
  const TOKEN_DECIMALS = tokenInfo.decimals;

  console.log(`🔧 Decimals: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);

  const amountInUSDC = ethers.parseUnits(TRADE_AMOUNT_USDC, USDC_DECIMALS);
  const MIN_PROFIT_UNITS = ethers.parseUnits(MIN_PROFIT_USDC, USDC_DECIMALS);

  console.log(`🔧 Trade Amount: $${TRADE_AMOUNT_USDC}`);
  console.log(
    `🔧 MIN_PROFIT_USDC: $${MIN_PROFIT_USDC} (base units: ${MIN_PROFIT_UNITS})`
  );

  const arbContract = new ethers.Contract(CONTRACT_ADDRESS, AaveFlashArbABI, provider);
  console.log(`▸ 🚀 Starting bidirectional live arbitrage scanner`);

  provider.on("block", async (blockNumber) => {
    console.log(`[${blockNumber}] 🔍 Scanning both directions...`);

    try {
      await scanDirection("A→B", ROUTER_A, ROUTER_B, tokenInfo, amountInUSDC, MIN_PROFIT_UNITS, arbContract);
      await scanDirection("B→A", ROUTER_B, ROUTER_A, tokenInfo, amountInUSDC, MIN_PROFIT_UNITS, arbContract);
    } catch (err) {
      console.error(`⚠️ Error during block ${blockNumber}:`, err.message);
    }
  });
}

// === SCANNING FUNCTION ===
async function scanDirection(label, buyRouter, sellRouter, tokenInfo, amountInUSDC, MIN_PROFIT_UNITS, arbContract) {
  const USDC_DECIMALS = TOKENS.USDC.decimals;
  const TOKEN_DECIMALS = tokenInfo.decimals;

  try {
    const buyRouterContract = new ethers.Contract(
      buyRouter,
      ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"],
      provider
    );

    const sellRouterContract = new ethers.Contract(
      sellRouter,
      ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"],
      provider
    );

    // Step 1: Estimate buy swap (USDC → token)
    const buyPath = [USDC, tokenInfo.address];
    const buyAmounts = await buyRouterContract.getAmountsOut(amountInUSDC, buyPath);
    const buyTokenOut = buyAmounts[1];

    // Step 2: Estimate sell swap (token → USDC)
    const sellPath = [tokenInfo.address, USDC];
    const sellAmounts = await sellRouterContract.getAmountsOut(buyTokenOut, sellPath);
    const sellUSDCOut = sellAmounts[1];

    // Step 3: Profit computation (all normalized to USDC)
    const profitBase = sellUSDCOut - amountInUSDC;
    const profitDisplay = Number(ethers.formatUnits(profitBase, USDC_DECIMALS));
    const profitPct = (profitDisplay / Number(TRADE_AMOUNT_USDC)) * 100;

    console.log(
      `[${label}] 💱 Buy → $${TRADE_AMOUNT_USDC} → ${ethers.formatUnits(
        buyTokenOut,
        TOKEN_DECIMALS
      )} TOKEN (~$${Number(TRADE_AMOUNT_USDC / (Number(ethers.formatUnits(buyTokenOut, TOKEN_DECIMALS)))).toFixed(6)} per token)`
    );

    console.log(`[${label}] 💲 Sell → $${Number(ethers.formatUnits(sellUSDCOut, USDC_DECIMALS)).toFixed(6)} USDC`);
    console.log(
      `[${label}] 🧮 Profit → $${profitDisplay.toFixed(6)} (${profitPct.toFixed(4)}%)`
    );

    // Step 4: callStatic simulation (safety preflight)
    try {
      await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenInfo.address, amountInUSDC);
      console.log(`[${label}] ✅ callStatic simulation passed (tx would succeed)`);
    } catch (simErr) {
      console.warn(`[${label}] ⚠️ Simulation failed: ${simErr.message}`);
    }

    if (profitBase >= MIN_PROFIT_UNITS) {
      console.log(`[${label}] 🚀 Profitable opportunity detected!`);
    } else {
      console.log(`[${label}] 🚫 Not profitable (below threshold).`);
    }
  } catch (err) {
    console.error(`[${label}] ❌ Error: ${err.message}`);
  }
}

// === START ===
init().catch((err) => {
  console.error("❌ Initialization failed:", err.message);
  process.exit(1);
});


