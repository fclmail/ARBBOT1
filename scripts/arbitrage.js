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
  isAddress,
  BigNumber
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
const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, USDC_ADDRESS, AMOUNT_IN_HUMAN };
const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
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
let MIN_PROFIT = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

// Clamp very small minProfit
if (MIN_PROFIT < 1 / 10 ** DECIMALS) {
  console.warn(`⚠️ MIN_PROFIT_USDC (${MIN_PROFIT}) too small for ${DECIMALS}-decimal token. Clamping to ${1 / 10 ** DECIMALS}`);
  MIN_PROFIT = 1 / 10 ** DECIMALS;
}

// --- Validate addresses ---
for (const [name, a] of [["BUY_ROUTER", buyRouterAddr], ["SELL_ROUTER", sellRouterAddr], ["TOKEN", tokenAddr], ["USDC_ADDRESS", usdcAddr], ["CONTRACT_ADDRESS", CONTRACT_ADDRESS]]) {
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
const amountIn = toUnits(AMOUNT_HUMAN);
const minProfitUnits = toUnits(MIN_PROFIT);

// --- Utility ---
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const now = () => new Date().toISOString();

// --- Arbitrage check for one direction ---
async function checkArbDirection(buyR, sellR, label) {
  try {
    const pathBuy = [usdcAddr, tokenAddr];
    const pathSell = [tokenAddr, usdcAddr];

    const buyAmounts = await buyR.getAmountsOut(amountIn, pathBuy);
    const tokenOut = BigNumber.from(buyAmounts[1]);

    const sellAmounts = await sellR.getAmountsOut(tokenOut, pathSell);
    const usdcOut = BigNumber.from(sellAmounts[1]);

    const profit = usdcOut.sub(amountIn);

    console.log(`${now()} [${label}] 💰 Buy -> token: ${fromUnits(tokenOut)} token`);
    console.log(`${now()} [${label}] 💵 Sell -> USDC: ${fromUnits(usdcOut)} USDC`);
    console.log(`${now()} [${label}] 🧮 Raw profit: ${fromUnits(profit)} USDC`);

    return { profit, buyR, sellR };
  } catch (err) {
    console.warn(`${now()} [${label}] ⚠️ Router call failed: ${err.reason || err.message}`);
    return { profit: BigNumber.from(-1) }; // negative to skip execution
  }
}

// --- Execute arbitrage if profitable ---
async function executeArb(buyR, sellR, label) {
  try {
    const gasEst = await arbContract.estimateGas.executeArbitrage(
      buyR.address,
      sellR.address,
      tokenAddr,
      amountIn
    );

    console.log(`${now()} [${label}] ⛽ Gas estimate: ${gasEst.toString()}`);

    const tx = await arbContract.executeArbitrage(
      buyR.address,
      sellR.address,
      tokenAddr,
      amountIn,
      { gasLimit: gasEst.mul(120).div(100) } // +20% buffer
    );

    console.log(`${now()} [${label}] 🧾 TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`${now()} [${label}] 🎉 TX confirmed: ${receipt.transactionHash}`);
    console.log(`${now()} [${label}] 💎 Arbitrage executed! Profit retained in contract.`);
  } catch (err) {
    console.error(`${now()} [${label}] ❌ Execution failed: ${err.reason || err.message}`);
  }
}

// --- Main loop ---
let iteration = 0;
async function runLoop() {
  while (true) {
    iteration++;
    console.log(`\n${now()} [#${iteration}] 🔍 Scanning block ${await provider.getBlockNumber()}...`);

    // Check both directions
    const directions = [
      { buyR: buyRouter, sellR: sellRouter, label: "A→B" },
      { buyR: sellRouter, sellR: buyRouter, label: "B→A" }
    ];

    for (const dir of directions) {
      const { profit, buyR, sellR } = await checkArbDirection(dir.buyR, dir.sellR, dir.label);
      if (profit.gte(minProfitUnits)) {
        console.log(`${now()} [${dir.label}] ✅ Profitable! Executing arbitrage...`);
        await executeArb(buyR, sellR, dir.label);
      } else {
        console.log(`${now()} [${dir.label}] 🚫 No profitable opportunity (profit <= min).`);
      }
    }

    await sleep(SCAN_MS);
  }
}

// --- Start ---
console.log(`${now()} ▸ 🚀 Starting live arbitrage scanner`);
console.log(`${now()} ▸ Config:`);
console.log(`   • Contract:        ${CONTRACT_ADDRESS}`);
console.log(`   • Buy Router:      ${buyRouterAddr}`);
console.log(`   • Sell Router:     ${sellRouterAddr}`);
console.log(`   • Token:           ${tokenAddr}`);
console.log(`   • USDC:            ${usdcAddr}`);
console.log(`   • Amount In:       ${AMOUNT_HUMAN} USDC`);
console.log(`   • Min Profit:      ${MIN_PROFIT} USDC`);
console.log(`   • Interval:        ${SCAN_MS} ms`);
console.log(`   • Wallet:          ${wallet.address}`);

runLoop().catch((err) => {
  console.error(`❌ Fatal error:`, err);
  process.exit(1);
});



