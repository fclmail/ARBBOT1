#!/usr/bin/env node
/**
 * scripts/arbitrage.js
 * Live arbitrage scanner + executor using on-chain getAmountsOut (UniswapV2-style routers).
 *
 * Required ENV:
 *  - RPC_URL
 *  - PRIVATE_KEY
 *  - BUY_ROUTER
 *  - SELL_ROUTER
 *  - TOKEN
 *  - USDC_ADDRESS
 *  - AMOUNT_IN_HUMAN
 *
 * Optional ENV:
 *  - CONTRACT_ADDRESS (default: deployed AaveFlashArb)
 *  - MIN_PROFIT_USDC (default: 0.0000001)
 *  - SCAN_INTERVAL_MS (default: 5000)
 */

import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseUnits,
  formatUnits,
  isAddress
} from "ethers";

const {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  USDC_ADDRESS,
  AMOUNT_IN_HUMAN,
  CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
  MIN_PROFIT_USDC,
  SCAN_INTERVAL_MS
} = process.env;

// --- Validate env vars ---
const required = {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  USDC_ADDRESS,
  AMOUNT_IN_HUMAN
};

const missing = Object.entries(required)
  .filter(([_, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// --- Config / defaults ---
const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
const rpcUrl = RPC_URL.trim();
const buyRouterAddr = BUY_ROUTER.trim();
const sellRouterAddr = SELL_ROUTER.trim();
const tokenAddr = TOKEN.trim();
const usdcAddr = USDC_ADDRESS.trim();
const AMOUNT_HUMAN = AMOUNT_IN_HUMAN.trim();
const DECIMALS = 6; // USDC decimals
const MIN_PROFIT = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

// --- Validate addresses ---
for (const [name, a] of [
  ["BUY_ROUTER", buyRouterAddr],
  ["SELL_ROUTER", sellRouterAddr],
  ["TOKEN", tokenAddr],
  ["USDC_ADDRESS", usdcAddr],
  ["CONTRACT_ADDRESS", CONTRACT_ADDRESS]
]) {
  if (!isAddress(a)) {
    console.error(`❌ Invalid Ethereum address for ${name}:`, a);
    process.exit(1);
  }
}

// --- Provider / wallet / contracts ---
const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

// --- ABIs ---
const UNIV2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];
const ARB_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
];

// --- Instances ---
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

// --- Helpers ---
const toUnits = (humanStr) => parseUnits(humanStr, DECIMALS);
const fromUnits = (big) => formatUnits(big, DECIMALS);

// ✅ Safe clamp for very small minProfit (fixes RangeError)
let safeMinProfit = Number(MIN_PROFIT);
if (safeMinProfit < 1 / 10 ** DECIMALS) {
  console.warn(
    `⚠️ MIN_PROFIT_USDC (${MIN_PROFIT}) is too small for ${DECIMALS}-decimal tokens. Clamping to ${1 / 10 ** DECIMALS}.`
  );
  safeMinProfit = 1 / 10 ** DECIMALS;
}

const minProfitUnits = toUnits(safeMinProfit.toFixed(DECIMALS));
const amountIn = toUnits(AMOUNT_HUMAN);

// --- Utility ---
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const now = () => new Date().toISOString();

// --- Start ---
console.log(`${now()} ▸ 🚀 Starting live arbitrage scanner`);
console.log(`${now()} ▸ Config:`);
console.log(`   • Contract:        ${CONTRACT_ADDRESS}`);
console.log(`   • Buy Router:      ${buyRouterAddr}`);
console.log(`   • Sell Router:     ${sellRouterAddr}`);
console.log(`   • Token:           ${tokenAddr}`);
console.log(`   • USDC:            ${usdcAddr}`);
console.log(`   • Amount In:       ${AMOUNT_HUMAN} USDC`);
console.log(`   • Min Profit:      ${safeMinProfit} USDC`);
console.log(`   • Interval:        ${SCAN_MS} ms`);
console.log(`   • Wallet:          ${wallet.address}`);

let iteration = 0;

// --- Main loop ---
async function runLoop() {
  while (true) {
    iteration++;
    try {
      const block = await provider.getBlockNumber();
      console.log(`\n${now()} [#${iteration}] 🔍 Block ${block} — scanning...`);

      const pathBuy = [usdcAddr, tokenAddr];
      const pathSell = [tokenAddr, usdcAddr];

      // --- Query buy route ---
      let buyOut;
      try {
        const buyAmounts = await buyRouter.getAmountsOut(amountIn, pathBuy);
        buyOut = buyAmounts[1];
      } catch (err) {
        console.warn(`${now()} [#${iteration}] ⚠️ Buy router failed: ${err.message}`);
        await sleep(SCAN_MS);
        continue;
      }

      // --- Query sell route ---
      let sellOut;
      try {
        const sellAmounts = await sellRouter.getAmountsOut(buyOut, pathSell);
        sellOut = sellAmounts[1];
      } catch (err) {
        console.warn(`${now()} [#${iteration}] ⚠️ Sell router failed: ${err.message}`);
        await sleep(SCAN_MS);
        continue;
      }

      // --- Compute profit ---
      const profit = sellOut - amountIn;

      console.log(`${now()} [#${iteration}] 💰 Buy -> token: ${fromUnits(buyOut)} token`);
      console.log(`${now()} [#${iteration}] 💵 Sell -> USDC: ${fromUnits(sellOut)} USDC`);
      console.log(`${now()} [#${iteration}] 🧮 Raw profit:  ${fromUnits(profit)} USDC`);

      // --- Execute if profitable ---
      if (profit > minProfitUnits) {
        console.log(`${now()} [#${iteration}] ✅ Profit found! Executing arbitrage...`);
        try {
          const gasEst = await arbContract.estimateGas.executeArbitrage(
            buyRouterAddr,
            sellRouterAddr,
            tokenAddr,
            amountIn
          );

          console.log(`${now()} [#${iteration}] ⛽ Gas estimate: ${gasEst.toString()}`);

          const tx = await arbContract.executeArbitrage(
            buyRouterAddr,
            sellRouterAddr,
            tokenAddr,
            amountIn,
            { gasLimit: gasEst.mul(120).div(100) } // +20% buffer
          );

          console.log(`${now()} [#${iteration}] 🧾 TX sent: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${now()} [#${iteration}] 🎉 TX confirmed: ${receipt.transactionHash}`);
          console.log(`${now()} [#${iteration}] 💎 Arbitrage executed! Profit retained in contract.`);
        } catch (err) {
          console.error(`${now()} [#${iteration}] ❌ Execution failed: ${err.message}`);
        }
      } else {
        console.log(`${now()} [#${iteration}] 🚫 No profitable opportunity (profit <= min).`);
      }
    } catch (err) {
      console.error(`${now()} [#${iteration}] ❌ Unexpected error:`, err);
    }

    await sleep(SCAN_MS);
  }
}

// --- Run ---
runLoop().catch((err) => {
  console.error(`❌ Fatal error:`, err);
  process.exit(1);
});



