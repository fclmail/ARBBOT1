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
let usdc;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.000001", 6);

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
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

function rebuild() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    ["function balanceOf(address) view returns(uint256)"],
    wallet
  );

  routerContracts = Object.fromEntries(
    Object.values(routers).map(r => [
      r,
      new ethers.Contract(
        r,
        ["function getAmountsOut(uint,address[]) view returns(uint[])"],
        provider
      )
    ])
  );
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  try {
    const out = await routerContracts[router].getAmountsOut(amount, path);
    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= TRADE SCAN ================= */

async function findTrade(buy, sell, token) {
  const buyOut = await quote(buy, TRADE_AMOUNT, [token, TOKENS.WMATIC]);
  if (!buyOut) return null;

  const sellOut = await quote(sell, buyOut, [TOKENS.WMATIC, token]);
  if (!sellOut) return null;

  const profit = sellOut - TRADE_AMOUNT;

  if (profit < MIN_PROFIT) return null;

  return {
    buy,
    sell,
    token,
    amountIn: TRADE_AMOUNT,
    expectedProfit: profit
  };
}

/* ================= EXECUTION ================= */

async function executeBatch(batch) {
  try {
    const before = await usdc.balanceOf(wallet.address);

    console.log("🚀 EXECUTING IMMEDIATELY\n");

    const tx = await wallet.sendTransaction({
      to: wallet.address, // placeholder (replace with vault contract in real system)
      value: 0
    });

    console.log(`TX SENT 0x${tx.hash.slice(2, 10)}...`);
    console.log("WAITING CONFIRMATION...\n");

    await provider.waitForTransaction(tx.hash);

    const after = await usdc.balanceOf(wallet.address);

    console.log(`CONTRACT BEFORE ${ethers.formatUnits(before, 6)}`);
    console.log(`CONTRACT AFTER  ${ethers.formatUnits(after, 6)}`);
    console.log(`REAL PROFIT     ${ethers.formatUnits(after - before, 6)}\n`);

    console.log("♻️ RESET COMPLETE\n");

    microTrades = [];
    runningProfit = 0n;
    isExecuting = false;

  } catch (e) {
    console.log("⚠️ EXECUTION FAILED:", e.message);
    isExecuting = false;
  }
}

/* ================= SCAN LOOP ================= */

async function scanLoop() {
  const tasks = [];

  for (const b of Object.values(routers)) {
    for (const s of Object.values(routers)) {
      if (b === s) continue;

      for (const t of Object.values(TOKENS)) {
        tasks.push({ buy: b, sell: s, token: t });
      }
    }
  }

  let i = 0;

  async function worker() {
    while (true) {
      if (isExecuting) continue;

      const task = tasks[i++ % tasks.length];

      const trade = await findTrade(
        task.buy,
        task.sell,
        task.token
      );

      if (!trade) continue;

      microTrades.push(trade);
      runningProfit += trade.expectedProfit;

      console.log(`RUNNING TOTAL ${ethers.formatUnits(runningProfit, 6)}`);

      /* ================= INSTANT EXECUTION TRIGGER ================= */

      if (
        runningProfit >= MIN_PROFIT &&
        !isExecuting
      ) {
        console.log("→ PROFIT THRESHOLD HIT");
        isExecuting = true;

        const batch = [...microTrades];

        await executeBatch(batch);
      }
    }
  }

  await Promise.all(
    Array.from({ length: 16 }, worker)
  );
}

/* ================= MAIN ================= */

(async function main() {
  console.log("🚀 BOT STARTED\n");

  provider = newProvider();
  rebuild();

  await scanLoop();
})();
