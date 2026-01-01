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
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6 decimals
const WETH = "0x7ceb23f17e97b3e19200c606ac193b5632a1dcd"; // WETH on Polygon (18 decimals)

// Hardcoded vault address
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = ethers.parseUnits("100", 6); // 100 USDC
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", 6); // 0.01 USDC minimum profit (6 decimals)
const SLIPPAGE_PCT = 15; // 15% slippage factor used in calculation

// -------------------- CONTRACTS --------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);

const VAULT_ABI = [
  "function depositProfit(uint amount) external"
];
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)"
];
const usdcContract = new ethers.Contract(USDC, ERC20_ABI, provider);

// -------------------- UTILS --------------------
// Decimals
const DEC_USDC = 6;
const DEC_WETH = 18;

// Helpers to ensure BigNumber and correct types
function ensureBigNumber(x) {
  if (ethers.BigNumber.isBigNumber(x)) return x;
  return ethers.BigNumber.from(x.toString());
}

// Fixed-point scales
const SCALE_USDC_6_TO_18 = ethers.BigNumber.from("1000000000000"); // 1e12 to convert 6->18
const ONE_18 = ethers.BigNumber.from("1000000000000000000"); // 1e18

// Convert USDC (6d) to 18-decimal fixed-point
function toUSDC18(usdc6_bn) {
  return ensureBigNumber(usdc6_bn).mul(SCALE_USDC_6_TO_18);
}

// Convert 18-decimal fixed-point to USDC (6d) for display or storage
function fromUSDC18(usdc18_bn) {
  return ensureBigNumber(usdc18_bn).div(SCALE_USDC_6_TO_18);
}

// Compute fixed-point profit using BigNumber arithmetic
function computeProfitStable(tradeAmountUSDC18, wethOut18, usdcBack18, slippagePct) {
  tradeAmountUSDC18 = ensureBigNumber(tradeAmountUSDC18);
  wethOut18 = ensureBigNumber(wethOut18);
  usdcBack18 = ensureBigNumber(usdcBack18);
  slippagePct = ensureBigNumber(slippagePct);

  const slippageFactor = ethers.BigNumber.from(100)
    .sub(slippagePct)
    .mul(ethers.BigNumber.from("1000000000000000000"))
    .div(ethers.BigNumber.from(100));

  const buyOutEstimate18 = wethOut18.mul(slippageFactor).div(ethers.BigNumber.from("1000000000000000000"));

  const grossProfit18 = usdcBack18.sub(tradeAmountUSDC18);

  let priceDiffPct18 = ethers.BigNumber.from(0);
  if (!tradeAmountUSDC18.isZero()) {
    priceDiffPct18 = grossProfit18.mul(ethers.BigNumber.from("1000000000000000000")).div(tradeAmountUSDC18);
  }

  const profitUSDC18 = grossProfit18.isNegative() ? ethers.BigNumber.from(0) : grossProfit18;

  return {
    profitUSDC18,
    priceDiffPct18,
    profitUSDC6: profitUSDC18.div(SCALE_USDC_6_TO_18),
    buyOutEstimate18
  };
}

// -------------------- ARBITRAGE SCAN --------------------
async function scanArbitrage() {
  try {
    console.log("Starting arbitrage scan...");

    const pathBuy_USDC_WETH = [USDC, WETH];
    const pathSell_WETH_USDC = [WETH, USDC];

    const tradeAmountUSDC18 = toUSDC18(TRADE_AMOUNT_USDC);

    let amountsOutBuy;
    try {
      amountsOutBuy = await quickRouter.getAmountsOut(tradeAmountUSDC18, pathBuy_USDC_WETH);
    } catch (e) {
      console.error("Error in getAmountsOut for buy path (USDC->WETH):", e);
      return;
    }
    if (!amountsOutBuy || amountsOutBuy.length < 2) {
      console.warn("Invalid buy path amountsOut. Skipping this cycle.");
      return;
    }
    const wethOut18 = amountsOutBuy[1];

    let amountsOutSell;
    try {
      amountsOutSell = await sushiRouter.getAmountsOut(wethOut18, pathSell_WETH_USDC);
    } catch (e) {
      console.error("Error in getAmountsOut for sell path (WETH->USDC):", e);
      return;
    }
    if (!amountsOutSell || amountsOutSell.length < 2) {
      console.warn("Invalid sell path amountsOut. Skipping this cycle.");
      return;
    }
    const usdcBack18 = amountsOutSell[1];

    const profitResult = computeProfitStable(tradeAmountUSDC18, wethOut18, usdcBack18, SLIPPAGE_PCT);
    const profitUSDC18 = profitResult.profitUSDC18;

    console.log(`Trade amount USDC18: ${tradeAmountUSDC18.toString()}`);
    console.log(`Profit USDC18: ${profitUSDC18.toString()}`);

    const minProfit18 = MIN_PROFIT_USDC.mul(SCALE_USDC_6_TO_18);
    const profitable = profitUSDC18.gte(minProfit18);

    if (profitable) {
      console.log("Profitable arbitrage detected. Proceed to deposit profit to vault.");
      const profitUSDC6ForDeposit = profitUSDC18.div(SCALE_USDC_6_TO_18);
      try {
        const tx = await vaultContract.depositProfit(profitUSDC6ForDeposit);
        console.log("Deposit tx hash:", tx.hash);
        await tx.wait();
        console.log("Deposit confirmed.");
      } catch (e) {
        console.error("Error depositing profit to vault:", e);
      }
    } else {
      console.log("No profitable arbitrage this cycle.");
    }

  } catch (err) {
    console.error("Unhandled error in scanArbitrage:", err);
  }
}

// -------------------- HELPERS --------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------- MAIN LOOP --------------------
async function main() {
  console.log("ARBITRAGE.js started");
  console.log(`USDC: ${USDC}, WETH: ${WETH}`);
  const INTERVAL_MS = 3000; // 3 seconds between scans

  while (true) {
    await scanArbitrage();
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error("Fatal error in ARB loop:", e);
  process.exit(1);
});
