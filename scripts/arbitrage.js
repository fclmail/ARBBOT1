import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const RPC_URL = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY in environment");
}
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory)"
];

// Tokens
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH = "0x7ceb23f17e97b3e19200c606ac193b5632a1dcd";

// Vault
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = ethers.parseUnits("100", 6); // bigint
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", 6); // bigint
const SLIPPAGE_PCT = 15n;

// -------------------- CONTRACTS --------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);

const VAULT_ABI = ["function depositProfit(uint256 amount) external"];
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// -------------------- FIXED-POINT CONSTANTS --------------------
const SCALE_USDC_6_TO_18 = 1_000_000_000_000n; // 1e12
const ONE_18 = 1_000_000_000_000_000_000n;     // 1e18

// -------------------- UTILS --------------------
function toUSDC18(usdc6) {
  return usdc6 * SCALE_USDC_6_TO_18;
}

function fromUSDC18(usdc18) {
  return usdc18 / SCALE_USDC_6_TO_18;
}

// -------------------- PROFIT CALC --------------------
function computeProfitStable(tradeAmountUSDC18, wethOut18, usdcBack18, slippagePct) {
  const slippageFactor = (100n - slippagePct) * ONE_18 / 100n;
  const buyOutEstimate18 = wethOut18 * slippageFactor / ONE_18;

  const grossProfit18 = usdcBack18 - tradeAmountUSDC18;
  const profitUSDC18 = grossProfit18 > 0n ? grossProfit18 : 0n;

  const priceDiffPct18 =
    tradeAmountUSDC18 > 0n
      ? (grossProfit18 * ONE_18) / tradeAmountUSDC18
      : 0n;

  return {
    profitUSDC18,
    profitUSDC6: fromUSDC18(profitUSDC18),
    priceDiffPct18,
    buyOutEstimate18
  };
}

// -------------------- ARBITRAGE LOOP --------------------
async function scanArbitrage() {
  console.log("Scanning arbitrage...");

  const pathBuy = [USDC, WETH];
  const pathSell = [WETH, USDC];

  const tradeAmountUSDC18 = toUSDC18(TRADE_AMOUNT_USDC);

  const buyAmounts = await quickRouter.getAmountsOut(tradeAmountUSDC18, pathBuy);
  const wethOut18 = buyAmounts[1];

  const sellAmounts = await sushiRouter.getAmountsOut(wethOut18, pathSell);
  const usdcBack18 = sellAmounts[1];

  const result = computeProfitStable(
    tradeAmountUSDC18,
    wethOut18,
    usdcBack18,
    SLIPPAGE_PCT
  );

  console.log("Profit (USDC6):", result.profitUSDC6.toString());

  const minProfit18 = MIN_PROFIT_USDC * SCALE_USDC_6_TO_18;

  if (result.profitUSDC18 >= minProfit18) {
    console.log("✅ Profitable — depositing to vault");
    const tx = await vaultContract.depositProfit(result.profitUSDC6);
    await tx.wait();
    console.log("Vault deposit confirmed");
  } else {
    console.log("❌ Below minimum profit");
  }
}

// -------------------- MAIN --------------------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("ARB BOT STARTED");
  while (true) {
    await scanArbitrage();
    await sleep(3000);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
