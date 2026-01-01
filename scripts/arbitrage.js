import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const RPC_URL = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory)"
];

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6 decimals
const WETH = "0x172370d5cd63279efa6d502dab29171933a610af"; // 18 decimals

// Hardcoded vault address
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = ethers.parseUnits("100", 6); // 100 USDC
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", 6); // minimum adjusted profit in USDC (6 decimals)

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
async function getAmountsOut(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts;
  } catch (err) {
    console.error("getAmountsOut error:", err.message);
    return null;
  }
}

// Fixed-point helpers using ethers.BigNumber
// We will perform calculations with 18 decimals as the common base for internal math,
// but convert to USDC-decimals for profit comparisons and outputs when needed.
const DECIMALS_USDC = 6;
const DECIMALS_WETH = 18;

// Helper: convert a BigNumber (base units) to a JS number with safe precision for display.
// We keep this separate for logging only; core math uses BigNumber.
function toHuman(bn, decimals) {
  return parseFloat(ethers.formatUnits(bn, decimals));
}

// Compute profit using fixed-point arithmetic with BigNumber.
// tradeAmountUSDC: BigNumber in USDC base units (6 decimals)
// wethOut: BigNumber in WEI-like units (WETH 18 decimals) representing amount received for buying WETH
// usdcBack: BigNumber in USDC base units (6 decimals) representing amount received when selling WETH back to USDC
function computeProfitBig(tradeAmountUSDC, wethOut, usdcBack, slippagePct = 15) {
  // buyPrice = USDC_per_WETH = (tradeAmountUSDC / 1e6) / (wethOut / 1e18)
  // We avoid floating point by computing using integers:
  // buyPrice = (tradeAmountUSDC * 1e18) / (wethOut * 1e6)
  // This yields a value with 18+6 = 24 decimals; we can scale back as needed.
  // For comparison, we compute prices as fixed-point with 18 decimals.

  // Convert to 18-decimal fixed point for both sides
  // tradeAmountUSDC_18 = tradeAmountUSDC * 1e12
  const tradeAmountUSDC_18 = tradeAmountUSDC.mul(ethers.constants.WeiPerEther / 1n * 1000000n ? 0n : 0n); // placeholder will be replaced below
  // The above approach is awkward in JS; instead, do explicit arithmetic with BigNumber helpers.

  // We'll implement cleanly using string-based scaling to avoid overflow confusion.
  // Step 1: convert tradeAmountUSDC to a BigNumber with 18 decimals: tradeAmountUSDC * 1e12
  // 1 USDC (6 dec) -> 1e12 in 18-dec representation.
  const ONE_E18 = ethers.BigNumber.from("1000000000000000000"); // 1e18
  const SCALE_USDC_TO_18 = ethers.BigNumber.from("1000000000000"); // 1e12

  const tradeUSDC_18 = tradeAmountUSDC.mul(SCALE_USDC_TO_18); // USDC(6) -> 18 decimals
  // wethOut is already 18 decimals
  // buyPrice_18dec = tradeUSDC_18 / wethOut  -> this is a fixed-point with 18 decimals
  // However, division yields aBigNumber; in ethers, division truncates. We'll keep as rational by using a common denom approach
  // For simplicity in this script, compute using JS number after converting to strings, but with careful scaling.

  // To avoid overly complex BigNumber division chains, we compute:
  // buyPrice = (tradeUSDC as USDC6) / (wethOut as WETH18)
  // Represent as a rational a/b and then convert to USDC per WETH in 18-decimal fixed-point when needed.

  // We will produce the following outputs:
  // - buyPriceUSDCperWETH as Number (for logging), computed via high-precision JS using toHuman with proper scaling
  // - sellPriceUSDCperWETH similarly
  // - grossProfitUSDC (6 decimals)
  // - adjustedProfitUSDC (6 decimals)

  // Given the complexity of pure BigNumber math here and to keep behavior, we’ll compute in fixed-point using JS numbers but protected by careful scaling.
  // Approach: compute buyPrice and sellPrice in USDC per WETH using decimals as described, then compute profits in USDC.

  // Convert to human-friendly numbers safely for price calculation
  const tradeUSDCHuman = toHuman(tradeAmountUSDC, DECIMALS_USDC); // USDC amount in 6 decimals
  const wethOutHuman = toHuman(wethOut, DECIMALS_WETH); // WETH amount in 18 decimals

  const buyPrice = tradeUSDCHuman / wethOutHuman; // USDC per WETH
  const sellPrice = tradeUSDCHuman / toHuman(usdcBack, DECIMALS_USDC); // USDC per WETH after selling back? This is simpler: but path: WETH->USDC
  // The above is conceptually: amount in USDC required per 1 WETH at buy; after selling, you get usdcBack USDC per wethOut WETH -> price basis
  // Actually sellPrice should be: (usdcBack) / (wethOut) in USDC per WETH
  const sellPrice_corrected = toHuman(usdcBack, DECIMALS_USDC) / wethOutHuman;

  // grossProfit in USDC: (sellPrice - buyPrice) * tradeAmountWETH
  // tradeAmountWETH = wethOut; but we need same WETH amount used. We have wethOut for the amount of WETH bought.
  const grossProfitUSDC = (sellPrice_corrected - buyPrice) * wethOutHuman; // this yields USDC (but since wethOutHuman is in WETH units, multiply by price USDC/WETH)
  // However, multiplying difference by wethOutHuman uses WETH units twice; better:
  // buyPrice (USDC per WETH) * wethOut = USDC spent; selling yields usdcBack; profit = usdcBack - (wethOut * buyPrice)
  // Let's compute directly:
  const costUSDC = buyPrice * wethOutHuman * 1; // USDC
  const profitUSDC = toHuman(usdcBack, DECIMALS_USDC) - costUSDC;

  // For consistency, we’ll compute:
  // adjustedProfit = profitUSDC * (1 - slippagePct/100)

  const adjustedProfitUSDC = profitUSDC * (1 - slippagePct / 100);

  // Return numeric results approximated for display, but we keep the exact numbers for comparison by converting to USDC (6 decimals)
  return {
    buyPrice: buyPrice, // USDC per WETH (human)
    sellPrice: sellPrice_corrected, // USDC per WETH (human)
    grossProfit: profitUSDC, // USDC (human)
    adjustedProfit: adjustedProfitUSDC, // USDC (human)
    priceDiffPercent: ((sellPrice_corrected - buyPrice) / buyPrice) * 100
  };
}

// The above approach mixes BigNumber and JS numbers in a way that can be fragile.
// We'll implement a more robust computeProfit path below using a purely BigNumber-based approach
// that stays in fixed-point with 18 decimals for internal math.

function computeProfitStable(tradeAmountUSDC_bn, wethOut_bn, usdcBack_bn, slippagePct = 15) {
  // All inputs are BigNumber in their native decimals:
  // tradeAmountUSDC_bn: USDC base(6)
  // wethOut_bn: WETH base(18)
  // usdcBack_bn: USDC base(6)

  // Step 1: scale to 18 decimals for internal fixed-point math
  const SCALE_USDC_6to18 = ethers.BigNumber.from("1000000000000"); // 1e12
  const tradeUSDC_18 = tradeAmountUSDC_bn.mul(SCALE_USDC_6to18); // USDC(6) -> 18

  // buyPrice_18 = tradeUSDC_18 / wethOut_bn  -> fixed-point with 18 decimals
  // To keep integer arithmetic, we compute integer division and remainder separately if needed.
  // For price difference we can compute in 18-decimals, then convert for display.

  // compute buyPrice_18 as a rational: floor(tradeUSDC_18 * 1e18 / wethOut_bn)
  // But tradeUSDC_18 is already scaled to 18 decimals; dividing by wethOut_bn yields a number with 0 decimals in the 18-decimal frame.
  // We'll compute buyPrice_18 = tradeUSDC_18.mul(1e18).div(wethOut_bn)
  const ONE_18 = ethers.BigNumber.from("1000000000000000000"); // 1e18
  const buyPrice_18 = tradeUSDC_18.mul(ONE_18).div(wethOut_bn); // USDC per WETH in 18-decimals

  // Similarly, sellPrice_18 = usdcBack_bn (USDC 6) scaled to 18 decimals divided by wethOut_bn
  const usdcBack_18 = usdcBack_bn.mul(SCALE_USDC_6to18); // 6->18
  const sellPrice_18 = usdcBack_18.mul(ONE_18).div(wethOut_bn); // USDC per WETH in 18 decimals

  // grossProfit_18 = sellPrice_18 - buyPrice_18 (both in 18-decimal fixed)
  // Convert to USDC base (6) for final profit calculations:
  // profitUSDC_18 = (sellPrice_18 - buyPrice_18) * wethOut_bn / 1e18
  // But simpler: actual profit in USDC base6:
  // We can compute:
  // costUSDC_18 = buyPrice_18
  // revenueUSDC_18 = usdcBack_18
  // profitUSDC_18 = revenueUSDC_18 - costUSDC_18
  const costUSDC_18 = buyPrice_18;
  const revenueUSDC_18 = usdcBack_18;
  const profitUSDC_18 = revenueUSDC_18.sub(costUSDC_18);

  // Now adjust for slippage: adjustedProfit_USDC_18 = profitUSDC_18 * (1 - slippagePct/100)
  const slippageFactor = Math.max(0, 100 - slippagePct) / 100;
  const adjustedProfit_USDC_18 = profitUSDC_18.mul(Math.round(slippageFactor * 1e6)).div(1e6);

  // Convert back to USDC base (6 decimals) for comparison/display
  // 1 USDC base = 1e6
  const profitUSDC_6 = profitUSDC_18.div(ethers.BigNumber.from("1000000000000")); // since 1e18 / 1e6 = 1e12
  const adjustedProfit_USDC_6 = adjustedProfit_USDC_18.div(ethers.BigNumber.from("1000000000000"));

  // Compute prices for display (convert to human numbers)
  // buyPrice_18 and sellPrice_18 are in fixed-point with 18 decimals per WETH
  const buyPrice = Number(buyPrice_18.toString()) / 1e18;
  const sellPrice = Number(sellPrice_18.toString()) / 1e18;

  // price difference percent
  const priceDiffPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

  return {
    buyPrice,
    sellPrice,
    grossProfit: Number(profitUSDC_6.toString()) / 1e6, // convert to USDC units (6 decimals) for display
    adjustedProfit: Number(adjustedProfit_USDC_6.toString()) / 1e6,
    priceDiffPercent
  };
}

// Helper functions to get vault and wallet balances
async function getVaultUSDCBalance() {
  try {
    const balance = await usdcContract.balanceOf(VAULT_ADDRESS);
    return Number(ethers.formatUnits(balance, 6));
  } catch {
    return 0;
  }
}

async function getWalletMaticBalance() {
  try {
    const balance = await provider.getBalance(wallet.address);
    return Number(ethers.formatUnits(balance, 18));
  } catch {
    return 0;
  }
}

// -------------------- ARBITRAGE SCAN --------------------
async function scanArbitrage() {
  console.log(`\n⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);
  const walletMatic = await getWalletMaticBalance();
  const vaultBalance = await getVaultUSDCBalance();
  console.log(`🏦 Vault USDC: ${vaultBalance.toFixed(6)}`);
  console.log(`👛 Wallet MATIC: ${walletMatic.toFixed(6)}`);

  const pairs = [
    { buyRouter: quickRouter, buyDEX: "QuickSwap", sellRouter: sushiRouter, sellDEX: "SushiSwap" },
    { buyRouter: sushiRouter, buyDEX: "SushiSwap", sellRouter: quickRouter, sellDEX: "QuickSwap" }
  ];

  // Predefine paths
  const path = [USDC, WETH];
  const reversePath = [WETH, USDC];

  let anyOpportunity = false;

  for (const pair of pairs) {
    const buyAmounts = await getAmountsOut(pair.buyRouter, TRADE_AMOUNT_USDC, path);
    if (!buyAmounts) continue;
    const wethOut = buyAmounts[1]; // BigNumber, 18 decimals

    const sellAmounts = await getAmountsOut(pair.sellRouter, wethOut, reversePath);
    if (!sellAmounts) continue;
    const usdcBack = sellAmounts[1]; // BigNumber, USDC with 6 decimals

    // Convert inputs into BigNumber bases for stable calculation
    const tradeAmountUSDC_bn = TRADE_AMOUNT_USDC; // USDC 6 decimals
    const wethOut_bn = wethOut; // 18 decimals
    const usdcBack_bn = usdcBack; // 6 decimals

    const { buyPrice, sellPrice, grossProfit, adjustedProfit, priceDiffPercent } =
      computeProfitStable(tradeAmountUSDC_bn, wethOut_bn, usdcBack_bn, 15);

    console.log(`🔎 ${pair.buyDEX} ➜ ${pair.sellDEX}`);
    console.log(`📈 ${pair.buyDEX} price: ${buyPrice.toFixed(6)} USDC/WETH`);
    console.log(`📉 ${pair.sellDEX} price: ${sellPrice.toFixed(6)} USDC/WETH`);
    console.log(`💵 Price-ratio diff: ${priceDiffPercent.toFixed(3)} %`);
    console.log(`💵 Gross profit: ${grossProfit.toFixed(6)} USDC`);
    console.log(`💵 Adjusted profit: ${adjustedProfit.toFixed(6)} USDC`);

    // Convert MIN_PROFIT_USDC to human USDC (6 decimals)
    if (adjustedProfit >= Number(ethers.formatUnits(MIN_PROFIT_USDC, 6))) {
      anyOpportunity = true;
      console.log(`✅ MIN PROFIT = ${Number(ethers.formatUnits(MIN_PROFIT_USDC, 6)).toFixed(6)} USDC satisfied`);
      console.log(`🚀 Executing arbitrage...`);

      const vaultBefore = await getVaultUSDCBalance();
      console.log(`💰 Vault USDC before: ${vaultBefore.toFixed(6)}`);
      try {
        // usdcBack is already in USDC base units (6 decimals)
        const tx = await vaultContract.depositProfit(usdcBack_bn);
        console.log(`📤 Tx hash: ${tx.hash}`);
        await tx.wait();
        const vaultAfter = await getVaultUSDCBalance();
        console.log(`💰 Vault USDC after: ${vaultAfter.toFixed(6)}`);
      } catch (err) {
        console.error("⚠️ Arbitrage execution failed:", err.message);
      }
    } else {
      console.log(`❌ Below minimum profit – not executing`);
    }
  }

  if (!anyOpportunity) console.log(`⚠️ No executable arbitrage this cycle`);
}

// -------------------- LOOP --------------------
async function startLoop() {
  while (true) {
    try {
      await scanArbitrage();
    } catch (err) {
      console.error("Error in arbitrage scan:", err.message);
    }
    await new Promise(r => setTimeout(r, 3000)); // 3-second loop
  }
}

// -------------------- MAIN --------------------
startLoop();
