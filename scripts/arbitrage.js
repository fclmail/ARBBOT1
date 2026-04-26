import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= SIMPLE LIMITER ================= */

const MAX_CONCURRENT = 25;

let activeCount = 0;
const queue = [];

function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeCount++;
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        activeCount--;
        if (queue.length) queue.shift()();
      }
    };

    if (activeCount < MAX_CONCURRENT) {
      run();
    } else {
      queue.push(run);
    }
  });
}

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
  "https://polygon-mainnet.core.chainstack.com/46058733cb4d6319063e68f8673791a8",
  "https://polygon-bor-rpc.publicnode.com"
 // "https://polygon-rpc.com",
 // "https://rpc.ankr.com/polygon",
//  "https://polygon.llamarpc.com"
];

let rpcIndex = 0;
let provider;
let wallet;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.01", 6);
const MIN_PROFIT = ethers.parseUnits("0.00001", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.02", 6);

const WORKER_COUNT = 16;
const SCAN_INTERVAL_MS = 1200;

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"
};

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= ABI ================= */

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= HELPERS ================= */

const fmt = (x) => ethers.formatUnits(x, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let isExecuting = false;

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
    Object.values(routers).map((r) => [
      r,
      new ethers.Contract(r, routerAbi, provider)
    ])
  );
}

async function initProvider() {
  provider = newProvider();
  await provider.getNetwork();
  rebuildContracts();
}

function rotateRPC() {
  console.log("RPC ROTATING...");
  provider = newProvider();
  rebuildContracts();
}

/* ================= SAFE RPC ================= */

async function safeRpc(fn, attempt = 0) {
  return limit(async () => {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 2) {
        rotateRPC();
        return null;
      }
      await sleep(150 * (2 ** attempt));
      return safeRpc(fn, attempt + 1);
    }
  });
}

/* ================= PATHS ================= */

function buildBuyPaths(token) {
  return [
    [USDC, token],
    [USDC, TOKENS.WETH, token],
    [USDC, TOKENS.WMATIC, token],
    [USDC, TOKENS.DAI, token],
    [USDC, TOKENS.USDT, token]
  ];
}

function buildSellPaths(token) {
  return [
    [token, USDC],
    [token, TOKENS.WETH, USDC],
    [token, TOKENS.WMATIC, USDC],
    [token, TOKENS.DAI, USDC],
    [token, TOKENS.USDT, USDC]
  ];
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  const res = await safeRpc(() =>
    routerContracts[router].getAmountsOut(amount, path)
  );
  return res ? res.at(-1) : null;
}

/* ================= FIND ================= */

async function findTrade(buy, sell, token) {
  for (const bp of buildBuyPaths(token)) {
    const buyOut = await quote(buy, TRADE_AMOUNT, bp);
    if (!buyOut) continue;

    for (const sp of buildSellPaths(token)) {
      const sellOut = await quote(sell, buyOut, sp);
      if (!sellOut) continue;

      const profit = sellOut - TRADE_AMOUNT;
      if (profit > MIN_PROFIT) {
        return { expectedProfit: profit };
      }
    }
  }
  return null;
}

/* ================= TASKS ================= */

function buildTasks() {
  const tasks = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
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

    const tasks = buildTasks();
    const chunkSize = Math.ceil(tasks.length / WORKER_COUNT);

    const chunks = [];
    for (let i = 0; i < tasks.length; i += chunkSize) {
      chunks.push(tasks.slice(i, i + chunkSize));
    }

    async function worker(chunk, id) {
      let localProfit = 0n;

      for (const task of chunk) {
        if (isExecuting) break;

        const trade = await findTrade(
          task.buy,
          task.sell,
          task.token
        );

        if (!trade) continue;

        localProfit += trade.expectedProfit;

        console.log(
          `W${id} TRADE | ${fmt(trade.expectedProfit)}`
        );

        if (localProfit >= MIN_BATCH_PROFIT / 2n) {
          console.log(
            `W${id} FLUSH | ${fmt(localProfit)}`
          );

          runningProfit += localProfit;
          localProfit = 0n;
        }
      }
    }

    await Promise.all(
      chunks.map((c, i) => worker(c, i))
    );

    await sleep(SCAN_INTERVAL_MS);
  }
}

/* ================= MAIN ================= */

(async () => {
  await initProvider();
  await scanLoop();
})();
