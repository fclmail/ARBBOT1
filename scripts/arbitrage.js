#!/usr/bin/env node
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

// --- Validate env vars ---
const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, USDC_ADDRESS, AMOUNT_IN_HUMAN };
const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
if (missing.length) { console.error(`❌ Missing required env vars: ${missing.join(", ")}`); process.exit(1); }

// --- Config ---
const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
const buyRouterAddr = BUY_ROUTER.trim();
const sellRouterAddr = SELL_ROUTER.trim();
const tokenAddr = TOKEN.trim();
const usdcAddr = USDC_ADDRESS.trim();
const DECIMALS = 6;
const AMOUNT_HUMAN = AMOUNT_IN_HUMAN.trim();
const safeMinProfit = Math.max(MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 1e-7, 1 / 10 ** DECIMALS);
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

const provider = new JsonRpcProvider(RPC_URL.trim());
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

const amountIn = parseUnits(AMOUNT_HUMAN, DECIMALS);
const minProfitUnits = parseUnits(safeMinProfit.toFixed(DECIMALS), DECIMALS);
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const now = () => new Date().toISOString();

console.log(`${now()} ▸ 🚀 Starting live arbitrage scanner`);

// --- Bidirectional check ---
async function checkArbDirection(buyR, sellR, label) {
  try {
    const pathBuy = [usdcAddr, tokenAddr];
    const pathSell = [tokenAddr, usdcAddr];
    const buyAmounts = await buyR.getAmountsOut(amountIn, pathBuy);
    const tokenOut = buyAmounts[1];
    const sellAmounts = await sellR.getAmountsOut(tokenOut, pathSell);
    const usdcOut = sellAmounts[1];
    const profit = usdcOut.sub(amountIn);

    console.log(`${now()} [${label}] 💰 Buy -> token: ${formatUnits(tokenOut, DECIMALS)} token`);
    console.log(`${now()} [${label}] 💵 Sell -> USDC: ${formatUnits(usdcOut, DECIMALS)} USDC`);
    console.log(`${now()} [${label}] 🧮 Raw profit: ${formatUnits(profit, DECIMALS)} USDC`);

    return { profit, buyR, sellR };
  } catch (err) {
    console.warn(`${now()} [${label}] ⚠️ Router call failed: ${err.reason || err.message}`);
    return { profit: amountIn.mul(-1) }; // negative to skip execution
  }
}

// --- Main loop ---
let iteration = 0;
async function runLoop() {
  while (true) {
    iteration++;
    const block = await provider.getBlockNumber();
    console.log(`\n${now()} [#${iteration}] 🔍 Block ${block} — scanning...`);

    const dir1 = await checkArbDirection(buyRouter, sellRouter, "A→B");
    const dir2 = await checkArbDirection(sellRouter, buyRouter, "B→A");

    const best = dir1.profit.gt(dir2.profit) ? dir1 : dir2;

    if (best.profit.gt(minProfitUnits)) {
      console.log(`${now()} [#${iteration}] ✅ Profitable opportunity detected! Executing arbitrage...`);
      try {
        const gasEst = await arbContract.estimateGas.executeArbitrage(best.buyR.address, best.sellR.address, tokenAddr, amountIn);
        const tx = await arbContract.executeArbitrage(best.buyR.address, best.sellR.address, tokenAddr, amountIn, { gasLimit: gasEst.mul(110).div(100) });
        console.log(`${now()} [#${iteration}] 🔗 TX sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`${now()} [#${iteration}] ✅ TX confirmed: ${receipt.transactionHash}`);
      } catch (err) {
        console.error(`${now()} [#${iteration}] ❌ Execution failed: ${err.message}`);
      }
    } else {
      console.log(`${now()} [#${iteration}] 🚫 No profitable opportunity (profit <= min).`);
    }

    await sleep(SCAN_MS);
  }
}

runLoop().catch(err => { console.error(`❌ Fatal error:`, err); process.exit(1); });



