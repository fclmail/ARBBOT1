import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= CONFIG ================= */
const RPC_POLYGON = process.env.RPC_POLYGON?.trim();
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY?.trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 1);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.0005);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 2000);
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
const DRY_RUN = (process.env.DRY_RUN || "false") === "true";

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const vaultAbi = [
  {
    name: "executeArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ]
  },
  {
    name: "usdc",
    type: "function",
    stateMutability: "view",
    outputs: [{ type: "address" }]
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS (V2 ONLY) ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS (FOCUSED SET) ================= */
const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quote(router, amountIn, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const amounts = await r.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= ARB CHECK (NO TX) ================= */
async function checkArb(buyRouter, sellRouter, token, usdc) {
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyPath = [usdc, token];
  const sellPath = [token, usdc];

  const buyOut = await quote(buyRouter, amountIn, buyPath);
  if (!buyOut) return null;

  const sellOut = await quote(sellRouter, buyOut, sellPath);
  if (!sellOut) return null;

  const received = Number(ethers.formatUnits(sellOut, 6));
  const profit = received - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return null;

  return {
    buyRouter,
    sellRouter,
    token,
    buyPath,
    sellPath,
    profit
  };
}

/* ================= EXECUTION QUEUE ================= */
const executionQueue = [];
let executing = false;

async function processQueue() {
  if (executing) return;
  executing = true;

  while (executionQueue.length) {
    const arb = executionQueue.shift();
    console.log(`🔥 EXECUTING | Profit: ${arb.profit.toFixed(6)} USDC`);

    if (DRY_RUN) {
      console.log("🧪 DRY RUN — skipped tx");
      continue;
    }

    try {
      const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
      const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

      const tx = await vault.executeArbitrage(
        arb.buyRouter,
        arb.sellRouter,
        amountIn,
        arb.buyPath,
        arb.sellPath,
        deadline
      );

      console.log(`⛓ TX SENT: ${tx.hash}`);
      await tx.wait();
      console.log("✅ TX CONFIRMED");
    } catch (e) {
      console.log("⚠️ TX FAILED:", e.message);
    }
  }

  executing = false;
}

/* ================= PARALLEL SCANNER ================= */
async function runWithConcurrency(tasks, limit) {
  const pool = [];
  for (const task of tasks) {
    const p = task();
    pool.push(p);
    if (pool.length >= limit) {
      await Promise.race(pool);
      pool.splice(pool.findIndex(x => x === p), 1);
    }
  }
  await Promise.allSettled(pool);
}

/* ================= SCAN ================= */
async function scan() {
  const usdc = await vault.usdc();
  const tasks = [];
  const found = [];

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;

        tasks.push(async () => {
          const arb = await checkArb(buy, sell, token, usdc);
          if (arb) found.push(arb);
        });
      }
    }
  }

  await runWithConcurrency(tasks, SCAN_CONCURRENCY);

  found
    .sort((a, b) => b.profit - a.profit)
    .forEach(a => executionQueue.push(a));

  if (found.length) {
    console.log(`💡 ${found.length} profitable arbs queued`);
    processQueue();
  }
}

/* ================= MAIN LOOP ================= */
(async () => {
  console.log("🚀 Parallel Arbitrage Bot Started");

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.log("⚠️ Scan error:", e.message);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
