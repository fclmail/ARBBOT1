#!/usr/bin/env node
/**
 * Live Polygon Arbitrage Bot — UniswapV2-style routers
 *
 * Required environment variables:
 *  - RPC_URL
 *  - PRIVATE_KEY
 *  - BUY_ROUTER
 *  - SELL_ROUTER
 *  - TOKEN
 *  - USDC_ADDRESS
 *  - AMOUNT_IN_HUMAN
 *
 * Optional:
 *  - CONTRACT_ADDRESS (default: 0x19B64f74553eE0ee26BA01BF34321735E4701C43)
 *  - MIN_PROFIT_USDC (default: 0.0000001)
 *  - SCAN_INTERVAL_MS (default: 5000)
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

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

// 🔍 Check for missing variables
const requiredVars = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, USDC_ADDRESS, AMOUNT_IN_HUMAN };
const missing = Object.entries(requiredVars)
  .filter(([_, v]) => !v || v.trim() === "")
  .map(([k]) => k);

if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// ✅ Defaults
const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
const buyRouterAddr = BUY_ROUTER.trim();
const sellRouterAddr = SELL_ROUTER.trim();
const tokenAddr = TOKEN.trim();
const usdcAddr = USDC_ADDRESS.trim();
const rpcUrl = RPC_URL.trim();
const amountHuman = AMOUNT_IN_HUMAN.trim();

// 🧮 Handle numeric settings safely
const MIN_PROFIT = MIN_PROFIT_USDC ? MIN_PROFIT_USDC.trim() : "0.0000001"; // string form, not scientific
const DECIMALS = 6;
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

// 🧠 Validate all addresses
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

// 🧱 Initialize provider, wallet, and contracts
const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

// Minimal UniswapV2 router ABI
const UNIV2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

// Arbitrage contract ABI
const ARB_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
];

const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

// 🧰 Helpers
const toUnits = (humanStr) => parseUnits(humanStr, DECIMALS);
const fromUnits = (big) => formatUnits(big, DECIMALS);
const minProfitUnits = toUnits(MIN_PROFIT);
const amountIn = toUnits(amountHuman);

function now() {
  return new Date().toISOString();
}
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// 📋 Startup log
console.log("─────────────────────────────────────────────");
console.log(`${now()} ▸ 🚀 Starting Polygon Arbitrage Scanner`);
console.log("─────────────────────────────────────────────");
console.log(`RPC_URL.............: ${rpcUrl}`);
console.log(`CONTRACT_ADDRESS....: ${CONTRACT_ADDRESS}`);
console.log(`BUY_ROUTER..........: ${buyRouterAddr}`);
console.log(`SELL_ROUTER.........: ${sellRouterAddr}`);
console.log(`TOKEN...............: ${tokenAddr}`);
console.log(`USDC_ADDRESS........: ${usdcAddr}`);
console.log(`AMOUNT_IN_HUMAN.....: ${amountHuman}`);
console.log(`MIN_PROFIT_USDC.....: ${MIN_PROFIT}`);
console.log(`SCAN_INTERVAL_MS....: ${SCAN_MS}`);
console.log("─────────────────────────────────────────────");

let iteration = 0;

// 🌀 Main loop
async function runLoop() {
  while (true) {
    iteration++;
    try {
      const block = await provider.getBlockNumber();
      console.log(`${now()} [#${iteration}] block=${block} — scanning...`);

      const pathBuy = [usdcAddr, tokenAddr];
      const pathSell = [tokenAddr, usdcAddr];

      // Step 1: Get buy output
      let buyAmounts;
      try {
        buyAmounts = await buyRouter.getAmountsOut(amountIn, pathBuy);
      } catch (err) {
        console.warn(`${now()} [#${iteration}] ⚠️ getAmountsOut failed on buyRouter: ${err.message}`);
        await sleep(SCAN_MS);
        continue;
      }

      const buyOut = buyAmounts[buyAmounts.length - 1];

      // Step 2: Sell back
      let sellAmounts;
      try {
        sellAmounts = await sellRouter.getAmountsOut(buyOut, pathSell);
      } catch (err) {
        console.warn(`${now()} [#${iteration}] ⚠️ getAmountsOut failed on sellRouter: ${err.message}`);
        await sleep(SCAN_MS);
        continue;
      }

      const sellOut = sellAmounts[sellAmounts.length - 1];
      const profit = sellOut - amountIn;

      // Log results
      console.log(`${now()} [#${iteration}] Buy out: ${fromUnits(buyOut)} token | Sell out: ${fromUnits(sellOut)} USDC | Profit: ${fromUnits(profit)} USDC`);

      // Profit check
      if (profit > minProfitUnits) {
        console.log(`${now()} [#${iteration}] 💰 Profit > ${MIN_PROFIT} — executing arbitrage...`);
        try {
          const gasEst = await arbContract.estimateGas.executeArbitrage(
            buyRouterAddr, sellRouterAddr, tokenAddr, amountIn
          );

          const tx = await arbContract.executeArbitrage(
            buyRouterAddr, sellRouterAddr, tokenAddr, amountIn,
            { gasLimit: gasEst.mul(110).div(100) } // +10% buffer
          );

          console.log(`${now()} [#${iteration}] ⛓️  TX sent: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${now()} [#${iteration}] ✅ TX confirmed: ${receipt.transactionHash}`);
        } catch (err) {
          console.error(`${now()} [#${iteration}] ❌ Execution failed: ${err.message}`);
        }
      } else {
        console.log(`${now()} [#${iteration}] No profitable arb (profit < ${MIN_PROFIT})`);
      }
    } catch (err) {
      console.error(`${now()} [#${iteration}] ⚠️ Loop error:`, err.message || err);
    }

    await sleep(SCAN_MS);
  }
}

// 🔄 Start
runLoop().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});


