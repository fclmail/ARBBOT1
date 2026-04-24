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
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.000001", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.0004", 6);

const WORKER_COUNT = 32;

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let isExecuting = false;

/* ================= ROUTE TRACKING ================= */

const routeMap = new Map();

function routeHash(buy, sell, token) {
  return ethers
    .keccak256(ethers.toUtf8Bytes(buy + sell + token))
    .slice(0, 6);
}

function logRoute(hash) {
  const prev = routeMap.get(hash) || 0;
  const next = prev + 1;
  routeMap.set(hash, next);

  if (prev === 0) {
    console.log(`ADDING TRADE ROUTE_HASH ${hash}`);
  } else {
    console.log(`ADDING TRADE ROUTE_HASH ${hash} (MERGED x${next})`);
  }
}

/* ================= TOKENS ================= */

const TOKENS = {
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= PROVIDER ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    ["function balanceOf(address) view returns(uint256)"],
    wallet
  );

  vault = new ethers.Contract(
    "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61",
    ["function executeFlashBatchArbitrage((address[],address[],uint256[],address[][],address[][],uint256))"],
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

/* ================= REALISTIC QUOTE ================= */

async function quote(router, amount, path) {
  try {
    const out = await routerContracts[router].getAmountsOut(amount, path);
    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= TRADE GENERATION ================= */

async function findTrade(buy, sell, token) {
  const hash = routeHash(buy, sell, token);
  logRoute(hash);

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
    expectedProfit: profit,
    hash
  };
}

/* ================= PRE-EXECUTION REVALIDATION ================= */

async function revalidateBatch(trades) {
  console.log("\n🔍 REVALIDATION START\n");

  const valid = [];
  let skipped = 0n;
  let total = 0n;

  for (const t of trades) {
    const buyOut = await quote(
      t.buy,
      t.amountIn,
      [t.token, TOKENS.WMATIC]
    );

    if (!buyOut) {
      console.log(`SKIP ${t.hash} → NO BUY QUOTE`);
      skipped++;
      continue;
    }

    const sellOut = await quote(
      t.sell,
      buyOut,
      [TOKENS.WMATIC, t.token]
    );

    if (!sellOut) {
      console.log(`SKIP ${t.hash} → NO SELL QUOTE`);
      skipped++;
      continue;
    }

    const profit = sellOut - t.amountIn;

    if (profit < MIN_PROFIT) {
      console.log(`SKIP ${t.hash} → LOW PROFIT`);
      skipped++;
      continue;
    }

    t.expectedProfit = profit;
    total += profit;
    valid.push(t);

    console.log(`OK ${t.hash} → PROFIT ${ethers.formatUnits(profit, 6)}`);
  }

  console.log(`\nVALID TRADES ${valid.length}`);
  console.log(`SKIPPED TRADES ${Number(skipped)}`);
  console.log(`TOTAL REVALIDATED PROFIT ${ethers.formatUnits(total, 6)}\n`);

  return { valid, total };
}

/* ================= EXECUTION ================= */

async function executeBatch(trades) {
  const { valid, total } = await revalidateBatch(trades);

  if (total < MIN_BATCH_PROFIT) {
    console.log("❌ BATCH REJECTED: BELOW MIN PROFIT\n");
    isExecuting = false;
    return;
  }

  console.log("🚀 EXECUTING AGGREGATED ROUTES\n");

  let tx;

  try {
    tx = await vault.executeFlashBatchArbitrage({
      buyRouters: valid.map(t => t.buy),
      sellRouters: valid.map(t => t.sell),
      amountsInUSDC: valid.map(t => t.amountIn),
      pathsToToken: [],
      pathsToUSDC: [],
      deadline: Math.floor(Date.now() / 1000) + 30
    });
  } catch (e) {
    console.log("⚠️ TX FAILED:", e.message);
    isExecuting = false;
    return;
  }

  console.log(`TX SENT ${tx.hash}`);
  console.log("WAITING CONFIRMATION...\n");

  await provider.waitForTransaction(tx.hash);

  const before = await usdc.balanceOf(wallet.address);

  const after = await usdc.balanceOf(wallet.address);

  console.log(`CONTRACT BEFORE ${ethers.formatUnits(before, 6)}`);
  console.log(`CONTRACT AFTER  ${ethers.formatUnits(after, 6)}`);
  console.log(
    `REAL PROFIT     ${ethers.formatUnits(after - before, 6)}\n`
  );

  console.log("♻️ RESET COMPLETE\n");

  isExecuting = false;
  microTrades = [];
  runningProfit = 0n;
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

      console.log(
        `RUNNING TOTAL ${ethers.formatUnits(runningProfit, 6)} | BATCH ${microTrades.length}/100`
      );

      if (
        microTrades.length >= 100 &&
        runningProfit >= MIN_BATCH_PROFIT &&
        !isExecuting
      ) {
        isExecuting = true;

        const batch = [...microTrades];

        await executeBatch(batch);
      }
    }
  }

  await Promise.all(
    Array.from({ length: WORKER_COUNT }, worker)
  );
}

/* ================= MAIN ================= */

(async function main() {
  console.log("🚀 BOT STARTED\n");

  provider = newProvider();
  rebuildContracts();

  await scanLoop();
})();
