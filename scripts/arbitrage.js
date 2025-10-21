import { ethers } from "ethers";
import "dotenv/config";

// 🟣 Polygon Provider
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// 🪙 Token Addresses (Polygon Mainnet)
const TOKENS = {
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  KLIMA: { address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
  USDCe: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
};

// 🧩 ABIs
const routerV2Abi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const quoterAbi = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"
];

// 🧠 Routers & Quoter Contracts
const routers = {
  QuickSwap: new ethers.Contract("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", routerV2Abi, provider),
  SushiSwap: new ethers.Contract("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", routerV2Abi, provider),
};

const uniswapV3Quoter = new ethers.Contract(
  "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
  quoterAbi,
  provider
);

// ⚙️ Config
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const MIN_PROFIT_USDC = Number(process.env.MIN_PROFIT_USDC || "0.00001");
const AMOUNT_IN = ethers.parseUnits(process.env.AMOUNT_IN || "0.0008", 6); // USDC.e decimals = 6

// 🧮 Helpers
const format = (amount, decimals) => Number(ethers.formatUnits(amount, decimals));

async function getV2Price(router, tokenIn, tokenOut, amountIn) {
  try {
    const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
    return amounts[1];
  } catch {
    return ethers.Zero;
  }
}

async function getV3Price(quoter, tokenIn, tokenOut, amountIn, fee = 3000) {
  try {
    const amountOut = await quoter.callStatic.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
    return amountOut;
  } catch {
    return ethers.Zero;
  }
}

// 🧭 Main Arbitrage Logic
async function checkArbitrage() {
  console.log("🚀 Starting Polygon Arbitrage Bot...");
  console.log(`✅ Connected as ${wallet.address}`);
  console.log(`💰 Amount in: ${ethers.formatUnits(AMOUNT_IN, 6)} USDC.e`);
  console.log(`💵 Minimum profit threshold: ${MIN_PROFIT_USDC} USDC.e\n`);

  for (const [symbol, token] of Object.entries(TOKENS)) {
    if (symbol === "USDCe") continue; // Skip base token

    console.log(`🔎 Checking token: ${symbol}`);

    const buyPriceQuick = await getV2Price(routers.QuickSwap, TOKENS.USDCe.address, token.address, AMOUNT_IN);
    const buyPriceSushi = await getV2Price(routers.SushiSwap, TOKENS.USDCe.address, token.address, AMOUNT_IN);

    const sellPriceQuick = await getV2Price(routers.QuickSwap, token.address, TOKENS.USDCe.address, buyPriceQuick);
    const sellPriceSushi = await getV2Price(routers.SushiSwap, token.address, TOKENS.USDCe.address, buyPriceSushi);

    const v3Price = await getV3Price(uniswapV3Quoter, TOKENS.USDCe.address, token.address, AMOUNT_IN);

    // Pick best buy/sell options
    const bestBuy = [buyPriceQuick, buyPriceSushi, v3Price].reduce((a, b) => (a > b ? b : a));
    const bestSell = [sellPriceQuick, sellPriceSushi, v3Price].reduce((a, b) => (a > b ? a : b));

    if (bestBuy === ethers.Zero || bestSell === ethers.Zero) {
      console.log(`⚠️ No liquidity for ${symbol} on available routers\n`);
      continue;
    }

    // Normalize output to USDC.e
    const profit = format(bestSell - bestBuy, 6);
    console.log(`💰 Estimated profit: $${profit.toFixed(6)}\n`);

    if (profit >= MIN_PROFIT_USDC) {
      console.log(`🚀 PROFITABLE OPPORTUNITY FOUND for ${symbol}!`);
      console.log(`💸 Potential Profit: $${profit.toFixed(6)} USDC.e`);
      // Here you would execute the transaction:
      // await executeArbitrage(bestRouter, ...)
    }
  }
}

// Run Bot
checkArbitrage()
  .then(() => console.log("✅ Scan complete"))
  .catch((err) => console.error("⚠️ Error:", err.message));
