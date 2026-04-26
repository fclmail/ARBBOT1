import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= LIMITER ================= */

const MAX_CONCURRENT = 20;
let active = 0;
const queue = [];

function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        active--;
        if (queue.length) queue.shift()();
      }
    };

    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
 // "https://polygon-rpc.com",
  "https://polygon-mainnet.core.chainstack.com/46058733cb4d6319063e68f8673791a8",
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon-bor.publicnode.com"
];

let rpcIndex = 0;
let provider;
let wallet;
let routerContracts;
let usdcContract;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.01", 6);
const MIN_PROFIT = ethers.parseUnits("0.000001", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.02", 6);

const WORKER_COUNT = 12;
const SCAN_INTERVAL_MS = 1500;

/* ================= ADDRESSES ================= */

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= ABI ================= */

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

/* ================= STATE ================= */

let runningProfit = 0n;
let isExecuting = false;

/* ================= HELPERS ================= */

const fmt = (x) => ethers.formatUnits(x, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= RPC ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;

  console.log(`ACTIVE RPC -> ${url}`);
  return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  routerContracts = Object.fromEntries(
    Object.entries(routers).map(([k, v]) => [
      k,
      new ethers.Contract(v, routerAbi, provider)
    ])
  );

  usdcContract = new ethers.Contract(
    USDC,
    erc20Abi,
    provider
  );
}

async function initProvider() {
  provider = newProvider();
  await provider.getNetwork();
  rebuildContracts();

  console.log(`WALLET -> 0x${wallet.address.slice(2, 8)}...`);
}

/* ================= SAFE RPC ================= */

async function safeRpc(fn, attempt = 0) {
  return limit(async () => {
    try {
      return await fn();
    } catch {
      if (attempt >= 2) return null;
      await sleep(150 * 2 ** attempt);
      return safeRpc(fn, attempt + 1);
    }
  });
}

/* ================= BALANCE ================= */

async function logBalances() {
  const [matic, usdc] = await Promise.all([
    safeRpc(() => provider.getBalance(wallet.address)),
    safeRpc(() => usdcContract.balanceOf(wallet.address))
  ]);

  if (!matic || !usdc) return;

  console.log(
    `BALANCE | 0x${wallet.address.slice(2, 8)}... | MATIC: ${ethers.formatEther(
      matic
    )} | USDC: ${fmt(usdc)}`
  );
}

/* ================= PATHS ================= */

function path(token) {
  return [
    [USDC, token],
    [token, USDC]
  ];
}

/* ================= QUOTE ================= */

async function quote(router, amount, p) {
  const res = await safeRpc(() =>
    routerContracts[router].getAmountsOut(amount, p)
  );
  return res?.at(-1) || null;
}

/* ================= FIND ================= */

async function findTrade(buy, sell, token) {
  console.log(`CHECK ${buy} -> ${sell} | ${token}`);

  for (const p of path(token)) {
    const out = await quote(buy, TRADE_AMOUNT, p);
    if (!out) continue;

    const back = await quote(sell, out, p);
    if (!back) continue;

    const profit = back - TRADE_AMOUNT;

    if (profit > MIN_PROFIT) {
      return profit;
    }
  }

  return null;
}

/* ================= TASKS ================= */

function buildTasks() {
  const tasks = [];

  for (const buy of Object.keys(routers)) {
    for (const sell of Object.keys(routers)) {
      if (buy === sell) continue;

      for (const token of Object.values(TOKENS)) {
        tasks.push({ buy, sell, token });
      }
    }
  }

  return tasks;
}

/* ================= LOOP ================= */

async function scanLoop() {
  while (true) {
    console.log("\nNEW SCAN (BATCH MODE)");

    await logBalances();

    const tasks = buildTasks();
    const chunkSize = Math.ceil(tasks.length / WORKER_COUNT);

    const chunks = [];
    for (let i = 0; i < tasks.length; i += chunkSize) {
      chunks.push(tasks.slice(i, i + chunkSize));
    }

    async function worker(chunk, id) {
      let local = 0n;

      for (const t of chunk) {
        if (isExecuting) break;

        const profit = await findTrade(t.buy, t.sell, t.token);

        if (!profit) {
          console.log(`W${id} NO TRADE`);
          continue;
        }

        local += profit;

        console.log(`W${id} TRADE | ${fmt(profit)}`);

        if (local >= MIN_BATCH_PROFIT / 2n) {
          runningProfit += local;

          console.log(
            `W${id} FLUSH | ${fmt(local)} | TOTAL ${fmt(runningProfit)}`
          );

          local = 0n;
        }
      }
    }

    await Promise.all(chunks.map((c, i) => worker(c, i)));

    await sleep(SCAN_INTERVAL_MS);
  }
}

/* ================= MAIN ================= */

(async () => {
  await initProvider();
  await scanLoop();
})();
