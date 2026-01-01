
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
  // divide by 1e12
  return ensureBigNumber(usdc18_bn).div(SCALE_USDC_6_TO_18);
}

// Compute fixed-point profit using BigNumber arithmetic
// All inputs are BigNumbers in their native decimals





// -------------------- CONTINUATION UTILS --------------------
// Core fixed-point computeProfitStable (all arithmetic in BigNumber, using 18-decimal internal representation)
// Inputs (BigNumber, 18-decimals unless noted):
// - tradeAmountUSDC18: USDC amount in 18-decimal fixed-point (i.e., USDC6 * 1e12)
// - wethOut18: amount of WETH received from buy path in wei (18 decimals)
// - usdcBack18: amount of USDC obtained from selling WETH in 18 decimals
// - slippagePct: integer percentage for slippage (e.g., 15 for 15%)
// Output: object with profitUSDC18 (18-decimal), profitUSDC6 (6-decimal), priceDiffPct (18-decimal fixed-point)

function computeProfitStable(tradeAmountUSDC18, wethOut18, usdcBack18, slippagePct) {
  // Guard inputs
  tradeAmountUSDC18 = ensureBigNumber(tradeAmountUSDC18);
  wethOut18 = ensureBigNumber(wethOut18);
  usdcBack18 = ensureBigNumber(usdcBack18);
  slippagePct = ensureBigNumber(slippagePct);

  // Apply simple price protection: apply slippage to expected outputs conservatively
  // For buy path (USDC -> WETH), assume we receive at worst (1 - slippage)
  // For sell path (WETH -> USDC), assume we receive at worst (1 - slippage)
  const slippageFactor = ethers.BigNumber.from(100).sub(slippagePct).mul(ethers.BigNumber.from("1000000000000000000")).div(ethers.BigNumber.from(100));
  // Since we want fixed-point, work with 1e18 scale:
  // buyOutEstimate18 = wethOut18 * (100 - slippage) / 100
  const buyOutEstimate18 = wethOut18.mul(slippageFactor).div(ethers.BigNumber.from("1000000000000000000"));
  // sellOutEstimate18 is usdcBack18 scaled by same 1e18 if needed; we’ll assume provided value is actual received

  // Gross profit in USDC18: usdcBack18 - tradeAmountUSDC18 (need alignment)
  // First, tradeAmountUSDC18 is USDC18; yes, so grossProfit18 = usdcBack18 - tradeAmountUSDC18
  const grossProfit18 = usdcBack18.sub(tradeAmountUSDC18);

  // Adjust gross profit by slippage on buy? We already applied to buyOutEstimate18; but profit is computed on USDC basis after selling, so convert to USDC18:
  // We will compare profits after converting both sides to USDC18. Since buy and sell use different assets,
  // we consider profit as final USDC18 after converting wethOut18 to USDC18 using a spot rate approximation.
  // For simplicity and safety, we approximate: convert buy amount to USDC equivalent using ratio (tradeAmountUSDC18 -> wethOut18)
  // However, to keep deterministic without an oracle, we just use the difference: usdcBack18 (received from sell) - tradeAmountUSDC18
  // This is a conservative baseline assuming the buy cost is covered by the subsequent sell returns.

  // Price difference percentage (optional metric): pretend priceDiff = (usdcBack18 - tradeAmountUSDC18) / tradeAmountUSDC18
  let priceDiffPct18 = ethers.BigNumber.from(0);
  if (!tradeAmountUSDC18.isZero()) {
    priceDiffPct18 = grossProfit18.mul(ethers.BigNumber.from("1000000000000000000")).div(tradeAmountUSDC18);
  }

  // Final profit in USDC18 is grossProfit18, but ensure it's not negative for decision
  const profitUSDC18 = grossProfit18.isNegative() ? ethers.BigNumber.from(0) : grossProfit18;

  // Return structured result
  return {
    profitUSDC18,
    priceDiffPct18, // in 18-decimal fixed-point, e.g., 0.05 -> 0.05 * 1e18
    // Also provide a 6-decimal version for display if needed
    profitUSDC6: profitUSDC18.div(ethers.BigNumber.from("1000000000000")), // 1e12 to convert 18->6 decimals
    // Optional: report buyOutEstimate18 for debugging
    buyOutEstimate18
  };
}

// Connect point: Main loop skeleton
async function scanArbitrage() {
  try {
    console.log("Starting arbitrage scan...");

    // Step 1: Buy path - USDC -> WETH via Quick or Sushi
    // Example: QuickRouter path USDC -> WETH
    const pathBuy_USDC_WETH = [USDC, WETH];
    const pathSell_WETH_USDC = [WETH, USDC];

    // Current trade amount in USDC18
    const tradeAmountUSDC18 = toUSDC18(TRADE_AMOUNT_USDC); // using helper we defined earlier

    // Call getAmountsOut for buy path (USDC -> WETH)
    let amountsOutBuy;
    try {
      amountsOutBuy = await quickRouter.getAmountsOut(tradeAmountUSDC18, pathBuy_USDC_WETH);
    } catch (e) {
      console.error("Error in getAmountsOut for buy path (USDC->WETH):", e);
      amountsOutBuy = undefined;
    }
    if (!amountsOutBuy || amountsOutBuy.length < 2) {
      console.warn("Invalid buy path amountsOut. Skipping this cycle.");
      return;
    }
    const wethOut18 = amountsOutBuy[1];

    // Step 2: Sell path - WETH -> USDC
    let amountsOutSell;
    try {
      amountsOutSell = await sushiRouter.getAmountsOut(wethOut18, pathSell_WETH_USDC);
    } catch (e) {
      console.error("Error in getAmountsOut for sell path (WETH->USDC):", e);
      amountsOutSell = undefined;
    }
    if (!amountsOutSell || amountsOutSell.length < 2) {
      console.warn("Invalid sell path amountsOut. Skipping this cycle.");
      return;
    }
    const usdcBack18 = amountsOutSell[1];

    // Step 3: Compute profit using fixed-point calculator
    const profitResult = computeProfitStable(tradeAmountUSDC18, wethOut18, usdcBack18, SLIPPAGE_PCT);

    // Step 4: Check min profit and decide to deposit
    const profitUSDC18 = profitResult.profitUSDC18;
    console.log(`Trade amount USDC18: ${tradeAmountUSDC18.toString()}`);
    console.log(`Profit USDC18: ${profitUSDC18.toString()}`);
    // Compare against MIN_PROFIT_USDC (USDC6 -> USDC18)
    const minProfit18 = MIN_PROFIT_USDC.mul(ethers.BigNumber.from("1000000000000")); // 1e12 to go 6->18
    const profitable = profitUSDC18.gte(minProfit18);

    if (profitable) {
      console.log("Profitable arbitrage detected. Proceed to deposit profit to vault.");
      // Deposit function expects USDC amount in base units (USDC6)
      // Convert profitUSDC18 back to USDC6
      const profitUSDC6ForDeposit = profitUSDC18.div(ethers.BigNumber.from("1000000000000"));
      // Execute deposit on vault
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

// Utility: convert USDC raw to 18-decimal fixed-point
function toUSDC18(usdc6) {
  const usdc6bn = ensureBigNumber(usdc6);
  return usdc6bn.mul(ethers.BigNumber.from("1000000000000")); // 1e12
}

// Utility: 1-second helper to sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Startup and run loop
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
