#!/usr/bin/env node
/**
 * scripts/arbitrage.js
 * Live arbitrage scanner + executor using on-chain getAmountsOut (UniswapV2-style routers).
 *
 * Required env:
 *  - RPC_URL
 *  - PRIVATE_KEY
 *  - BUY_ROUTER
 *  - SELL_ROUTER
 *  - TOKEN          (token to arbitrage)
 *  - AMOUNT_IN_HUMAN (amount in USDC human units, e.g. "100")
 *  - USDC_ADDRESS   (USDC token address on Polygon)
 *
 * Optional env:
 *  - CONTRACT_ADDRESS (defaults to 0x19B64f74553eE0ee26BA01BF34321735E4701C43)
 *  - MIN_PROFIT_USDC (defaults to 0.0000001)
 *  - SCAN_INTERVAL_MS (defaults to 5000)
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

const {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN,
  USDC_ADDRESS,
  CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
  MIN_PROFIT_USDC,
  SCAN_INTERVAL_MS
} = process.env;

// -------------------- Validate env variables --------------------
const requiredVars = ["RPC_URL","PRIVATE_KEY","BUY_ROUTER","SELL_ROUTER","TOKEN","AMOUNT_IN_HUMAN","USDC_ADDRESS"];
const missing = requiredVars.filter(v => !process.env[v] || process.env[v].trim() === "");
if (missing.length) {
  console.error("❌ Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

// Trim variables
const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
const buyRouterAddr = BUY_ROUTER.trim();
const sellRouterAddr = SELL_ROUTER.trim();
const tokenAddr = TOKEN.trim();
const usdcAddr = USDC_ADDRESS.trim();
const amountHuman = AMOUNT_IN_HUMAN.trim();
const DECIMALS = 6;
const MIN_PROFIT = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

// Validate Ethereum addresses
for (const [name, a] of [
  ["BUY_ROUTER", buyRouterAddr],
  ["SELL_ROUTER", sellRouterAddr],
  ["TOKEN", tokenAddr],
  ["CONTRACT_ADDRESS", CONTRACT_ADDRESS],
  ["USDC_ADDRESS", usdcAddr]
]) {
  if (!isAddress(a)) {
    console.error(`❌ Invalid Ethereum address for ${name}:`, a);
    process.exit(1);
  }
}

// -------------------- Provider & Wallet --------------------
const provider = new JsonRpcProvider(RPC_URL.trim());
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

// -------------------- ABIs --------------------
// Minimal UniswapV2-style router ABI (getAmountsOut)
const UNIV2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

// Minimal arb contract ABI (executeArbitrage)
const ARB_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
];

// Contract instances
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

// -------------------- Helpers --------------------
const toUnits = (humanStr) => parseUnits(humanStr, DECIMALS);
const fromUnits = (big) => formatUnits(big, DECIMALS);
const amountIn = toUnits(amountHuman);
const minProfitUnits = toUnits(String(MIN_PROFIT));

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

let iteration = 0;

// -------------------- Main Loop --------------------
async function runLoop() {
  console.log(`${now()} ▸ Starting ARB bot`);
  console.log(`${now()} ▸ Config: contract=${CONTRACT_ADDRESS}, buyRouter=${buyRouterAddr}, sellRouter=${sellRouterAddr}, token=${tokenAddr}, amountIn=${amountHuman}, minProfit=${MIN_PROFIT}`);

  while (true) {
    iteration++;
    try {
      const block = await provider.getBlockNumber();
      console.log(`${now()} [#${iteration}] Block=${block} — scanning...`);

      const pathBuy = [usdcAddr, tokenAddr];
      const pathSell = [tokenAddr, usdcAddr];

      // 1️⃣ Buy
      let buyAmounts;
      try {
        buyAmounts = await buyRouter.getAmountsOut(amountIn, pathBuy);
      } catch (err) {
        console.warn(`${now()} [#${iteration}] getAmountsOut failed on buyRouter:`, err.message || err);
        await sleep(SCAN_MS);
        continue;
      }
      const buyOut = buyAmounts[buyAmounts.length - 1];

      // 2️⃣ Sell
      let sellAmounts;
      try {
        sellAmounts = await sellRouter.getAmountsOut(buyOut, pathSell);
      } catch (err) {
        console.warn(`${now()} [#${iteration}] getAmountsOut failed on sellRouter:`, err.message || err);
        await sleep(SCAN_MS);
        continue;
      }
      const sellOut = sellAmounts[sellAmounts.length - 1];

      // 3️⃣ Profit
      const profit = sellOut - amountIn;

      // -------------------- Logging --------------------
      console.log(`${now()} [#${iteration}] Buy amount (token) = ${buyOut.toString()} (${fromUnits(buyOut)})`);
      console.log(`${now()} [#${iteration}] Sell amount (USDC) = ${sellOut.toString()} (${fromUnits(sellOut)})`);
      console.log(`${now()} [#${iteration}] Invested USDC = ${amountIn.toString()} (${fromUnits(amountIn)})`);
      console.log(`${now()} [#${iteration}] Raw profit = ${profit.toString()} (${fromUnits(profit)})`);

      // 4️⃣ Execute arbitrage if profit positive
      if (profit > 0n) {
        console.log(`${now()} [#${iteration}] Profit positive — executing arbitrage...`);
        try {
          const gasEst = await arbContract.estimateGas.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn);
          console.log(`${now()} [#${iteration}] Gas estimate: ${gasEst.toString()}`);
          const tx = await arbContract.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn, { gasLimit: gasEst.mul(110).div(100) });
          console.log(`${now()} [#${iteration}] Transaction sent: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${now()} [#${iteration}] Transaction confirmed: ${receipt.transactionHash}`);
          console.log(`${now()} [#${iteration}] Arbitrage executed — profit remains in contract balance`);
        } catch (err) {
          console.error(`${now()} [#${iteration}] Execution failed:`, err);
        }
      } else {
        console.log(`${now()} [#${iteration}] No positive profit. Skipping execution.`);
      }

    } catch (err) {
      console.error(`${now()} [#${iteration}] Unexpected error:`, err);
    }

    await sleep(SCAN_MS);
  }
}

// -------------------- Start --------------------
runLoop().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

