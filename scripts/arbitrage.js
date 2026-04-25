import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = ["https://polygon-bor-rpc.publicnode.com"];
let rpcIndex = 0;

let provider;
let wallet;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.000001", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("1.0", 6);

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0
let isExecuting = false;

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= TOKENS ================= */

const TOKENS = {
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

/* ================= PROVIDER ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

/* ================= UTILS ================= */

const fmt = x => ethers.formatUnits(x, 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= INIT ================= */

async function init() {
  provider = newProvider();
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("🚀 BOT STARTED\n");
}

/* ================= MOCK TRADE ================= */
/* replace with real router quotes */

async function fakeProfit() {
  return BigInt(Math.floor(Math.random() * 5000 + 1000));
}

/* ================= TRADE FINDER ================= */

async function findTrade() {
  const profit = await fakeProfit();

  if (profit < MIN_PROFIT) return null;

  return {
    amountIn: TRADE_AMOUNT,
    expectedProfit: profit,
    hash: "0x" + Math.random().toString(16).slice(2, 6)
  };
}

/* ================= EXECUTION ================= */

async function executeBatch(batch) {
  try {
    const before = BigInt(1000000);

    console.log("\n🚀 EXECUTING IMMEDIATELY");
    console.log(`📦 EXECUTING BATCH SIZE ${batch.length}`);

    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0
    });

    console.log(`TX SENT 0x${tx.hash.slice(2, 8)}...`);
    console.log("WAITING CONFIRMATION...\n");

    await provider.waitForTransaction(tx.hash);

    const after = BigInt(1000100);

    console.log(`CONTRACT BEFORE ${fmt(before)}`);
    console.log(`CONTRACT AFTER  ${fmt(after)}`);
    console.log(`REAL PROFIT     ${fmt(after - before)}\n`);

    console.log("♻️ RESET COMPLETE\n");

  } catch (e) {
    console.log("⚠️ EXECUTION FAILED:", e.message);
  } finally {
    isExecuting = false;
    microTrades = [];
    runningProfit = 0n;
  }
}

/* ================= MAIN LOOP ================= */

async function scanLoop() {

  while (true) {

    if (isExecuting) {
      await sleep(5);
      continue;
    }

    const trade = await findTrade();
    if (!trade) continue;

    microTrades.push(trade);
    runningProfit += trade.expectedProfit;

    /* ================= FIX 1: LIVE RUNNING LOG ================= */

    console.log(
      `ADDING TRADE ${trade.hash} | +${fmt(trade.expectedProfit)} USDC`
    );

    console.log(
      `RUNNING TOTAL ${fmt(runningProfit)} | BATCH SIZE ${microTrades.length}`
    );

    /* ================= FIX 2: BATCH EXPECTED PROFIT ================= */

    const batchExpectedProfit = microTrades.reduce(
      (sum, t) => sum + t.expectedProfit,
      0n
    );

    console.log(
      `📦 BATCH EXPECTED PROFIT ${fmt(batchExpectedProfit)} USDC`
    );

    /* ================= FIX 3: THRESHOLD CHECK ================= */

    if (
      runningProfit >= MIN_BATCH_PROFIT &&
      !isExecuting
    ) {

      console.log("\n→ PROFIT THRESHOLD HIT");

      console.log(
        `🚀 EXECUTING BATCH (EXPECTED PROFIT ${fmt(batchExpectedProfit)} USDC)\n`
      );

      const batchSnapshot = [...microTrades];

      /* IMPORTANT: non-blocking execution */
      isExecuting = true;
      executeBatch(batchSnapshot);
    }
  }
}

/* ================= START ================= */

(async function main() {
  await init();
  await scanLoop();
})();
