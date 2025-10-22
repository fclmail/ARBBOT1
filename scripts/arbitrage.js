#!/usr/bin/env node
/**
 * Bidirectional arbitrage scanner + executor
 * Ethers v6 compatible, fixed BigNumber/parseUnits issues
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress, toBigInt } from "ethers";

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
const DECIMALS = 6;
let MIN_PROFIT = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;
if (MIN_PROFIT < 1 / 10 ** DECIMALS) {
  console.warn(`⚠️ MIN_PROFIT_USDC (${MIN_PROFIT}) too small for ${DECIMALS}-decimal token. Clamping to ${1 / 10 ** DECIMALS}`);
  MIN_PROFIT = 1 / 10 ** DECIMALS;
}
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

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
const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

// --- Instances ---
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

// --- Helpers ---
const toUnits = (humanStr) => parseUnits(humanStr.toString(), DECIMALS);
const fromUnits = (big) => formatUnits(big, DECIMALS);
const amountIn = toUnits(AMOUNT_HUMAN);
const minProfitUnits = toUnits(MIN_PROFIT.toString());
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const now = () => new Date().toISOString();

// --- Bidirectional scan ---
async function checkArbDirection(buyR, sellR, direction) {
  try {
    const pathBuy = [usdcAddr, tokenAddr];
    const pathSell = [tokenAddr, usdcAddr];

    const buyAmounts = await buyR.getAmountsOut(amountIn, pathBuy);
    const buyOut = BigInt(buyAmounts[1].toString());

    const sellAmounts = await sellR.getAmountsOut(buyOut, pathSell);
    const sellOut = BigInt(sellAmounts[1].toString());

    const profit = sellOut - BigInt(amountIn.toString());

    console.log(`${now()} [${direction}] 💰 Buy -> token: ${fromUnits(buyOut)} token`);
    console.log(`${now()} [${direction}] 💵 Sell -> USDC: ${fromUnits(sellOut)} USDC`);
    console.log(`${now()} [${direction}] 🧮 Profit: ${fromUnits(profit)} USDC`);

    if (profit > BigInt(minProfitUnits.toString())) {
      console.log(`${now()} [${direction}] ✅ Executing arbitrage...`);
      try {
        const gasEst = await arbContract.estimateGas.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountIn);
        const tx = await arbContract.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountIn, { gasLimit: gasEst.mul(120).div(100) });
        console.log(`${now()} [${direction}] 🧾 TX sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`${now()} [${direction}] 🎉 TX confirmed: ${receipt.transactionHash}`);
      } catch (err) {
        console.error(`${now()} [${direction}] ❌ Execution failed: ${err.message}`);
      }
    } else {
      console.log(`${now()} [${direction}] 🚫 No profitable opportunity.`);
    }
  } catch (err) {
    console.warn(`${now()} [${direction}] ⚠️ Router call failed: ${err.message}`);
  }
}

// --- Main loop ---
let iteration = 0;
async function runLoop() {
  while (true) {
    iteration++;
    const block = await provider.getBlockNumber();
    console.log(`\n${now()} [#${iteration}] 🔍 Block ${block} — scanning both directions...`);

    // 1️⃣ Direction: BUY_ROUTER as buy, SELL_ROUTER as sell
    await checkArbDirection(buyRouter, sellRouter, "A→B");

    // 2️⃣ Direction: SELL_ROUTER as buy, BUY_ROUTER as sell (reverse)
    await checkArbDirection(sellRouter, buyRouter, "B→A");

    await sleep(SCAN_MS);
  }
}

// --- Start ---
console.log(`${now()} ▸ 🚀 Starting bidirectional live arbitrage scanner`);
runLoop().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
