import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= PROCESS ERROR GUARD ================= */

process.on("unhandledRejection", async (err) => {
  const msg = (err?.message || "").toLowerCase();

  if (
    err?.code === "ECONNRESET" ||
    msg.includes("econnreset") ||
    msg.includes("failed to detect network")
  ) {
    console.log("PROCESS RECOVERING FROM RPC FAILURE...");
    await initProvider();
    return;
  }

  throw err;
});

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPCS ================= */

const RPCS = [
  "https://polygon-mainnet.core.chainstack.com/46058733cb4d6319063e68f8673791a8"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.01", 6);
const MIN_PROFIT = ethers.parseUnits("0.00001", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.02", 6);

const MAX_BATCH_SIZE = 1000;
const SCAN_INTERVAL_MS = 500;
const DEADLINE_SECONDS = 60;
const WORKER_COUNT = 128;

const RPC_CALL_MAX_RETRIES = 2;
const RPC_BACKOFF_BASE_MS = 150;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x8147a186000A5436995E200eF60536237095B164";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

const contractAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"
};

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

  return new ethers.JsonRpcProvider(
    url,
    { name: "matic", chainId: 137 },
    { staticNetwork: true }
  );
}

function rebuildContracts() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(USDC, erc20Abi, provider);
  vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

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

async function safeRpc(fn, attempt = 0) {
  try {
    return await fn();
  } catch (e) {
    if (attempt >= RPC_CALL_MAX_RETRIES) {
      rotateRPC();
      throw e;
    }
    await sleep(RPC_BACKOFF_BASE_MS * (2 ** attempt));
    return safeRpc(fn, attempt + 1);
  }
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  try {
    const out = await safeRpc(() =>
      routerContracts[router].getAmountsOut(amount, path)
    );
    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= PATHS ================= */

const buildBuyPaths = (t) => [
  [USDC, t],
  [USDC, TOKENS.WETH, t],
  [USDC, TOKENS.WMATIC, t]
];

const buildSellPaths = (t) => [
  [t, USDC],
  [t, TOKENS.WETH, USDC],
  [t, TOKENS.WMATIC, USDC]
];

/* ================= FIND ================= */

async function findTrade(buy, sell, token) {
  for (const bp of buildBuyPaths(token)) {
    const buyOut = await quote(buy, TRADE_AMOUNT, bp);
    if (!buyOut) continue;

    for (const sp of buildSellPaths(token)) {
      const sellOut = await quote(sell, buyOut, sp);
      if (!sellOut) continue;

      const profit = sellOut - TRADE_AMOUNT;
      if (profit < MIN_PROFIT) continue;

      return {
        buy,
        sell,
        token,
        amountIn: TRADE_AMOUNT,
        buyPath: bp,
        sellPath: sp,
        expectedProfit: profit
      };
    }
  }
  return null;
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {
  if (!trades.length) return;

  console.log(`EXECUTING ${trades.length} TRADES`);

  const tx = await vault.executeFlashBatchArbitrage({
    buyRouters: trades.map(t => t.buy),
    sellRouters: trades.map(t => t.sell),
    amountsInUSDC: trades.map(t => t.amountIn),
    pathsToToken: trades.map(t => t.buyPath),
    pathsToUSDC: trades.map(t => t.sellPath),
    deadline: Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
  });

  console.log(`TX ${tx.hash}`);
  await tx.wait();

  console.log("BATCH COMPLETE");

  microTrades = [];
  runningProfit = 0n;
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

/* ================= OPTIMIZED SCAN LOOP ================= */

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
      let localTrades = [];
      let localProfit = 0n;

      for (const task of chunk) {
        if (isExecuting) break;

        const trade = await findTrade(
          task.buy,
          task.sell,
          task.token
        );

        if (!trade) continue;

        localTrades.push(trade);
        localProfit += trade.expectedProfit;

        console.log(
          `W${id} TRADE | ${fmt(trade.expectedProfit)}`
        );

        if (localProfit >= MIN_BATCH_PROFIT / 2n) {
          microTrades.push(...localTrades);
          runningProfit += localProfit;

          console.log(
            `W${id} FLUSH | ${fmt(localProfit)}`
          );

          localTrades = [];
          localProfit = 0n;
        }
      }
    }

    await Promise.all(
      chunks.map((c, i) => worker(c, i))
    );

    if (runningProfit >= MIN_BATCH_PROFIT && !isExecuting) {
      isExecuting = true;

      try {
        console.log(
          `GLOBAL EXECUTION: ${microTrades.length} trades`
        );
        await executeBatch([...microTrades]);
      } finally {
        isExecuting = false;
      }
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

/* ================= MAIN ================= */

(async () => {
  await initProvider();
  await scanLoop();
})();
