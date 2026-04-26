import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE KEY");

/* ================= RPC (priority order) ================= */

const RPCS = [
  "https://polygon-mainnet.core.chainstack.com/46058733cb4d6319063e68f8673791a8",
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon"
];

let rpcIndex = 0;
let provider;
let wallet;
let routerContracts;
let usdcContract;

/* ================= LIMITER ================= */

const MAX_CONCURRENT = 15;
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

/* ================= TOKENS ================= */

const USDC = {
  addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  decimals: 6,
  symbol: "USDC"
};

const TOKENS = {
  WETH: {
    addr: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    decimals: 18
  },
  WMATIC: {
    addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    decimals: 18
  },
  DAI: {
    addr: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    decimals: 18
  },
  USDT: {
    addr: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    decimals: 6
  }
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

const TRADE_AMOUNT = 10_000n; // 0.01 USDC in raw 6 decimals = 10_000
const MIN_PROFIT = 100n;
const MIN_BATCH_PROFIT = 200n;

let runningProfit = 0n;

/* ================= RPC ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;

  console.log(`ACTIVE RPC -> ${url}`);
  return new ethers.JsonRpcProvider(url);
}

function rebuild() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  routerContracts = Object.fromEntries(
    Object.entries(routers).map(([k, v]) => [
      k,
      new ethers.Contract(v, routerAbi, provider)
    ])
  );

  usdcContract = new ethers.Contract(
    USDC.addr,
    erc20Abi,
    provider
  );
}

async function init() {
  provider = newProvider();
  await provider.getNetwork();
  rebuild();

  console.log(`WALLET -> 0x${wallet.address.slice(2, 8)}...`);
}

/* ================= SAFE RPC ================= */

async function safeRpc(fn, attempt = 0) {
  return limit(async () => {
    try {
      return await fn();
    } catch {
      if (attempt >= 2) return null;
      return safeRpc(fn, attempt + 1);
    }
  });
}

/* ================= BALANCE ================= */

async function logBalances() {
  const bal = await safeRpc(() =>
    usdcContract.balanceOf(wallet.address)
  );

  const matic = await safeRpc(() =>
    provider.getBalance(wallet.address)
  );

  if (!bal || !matic) return;

  console.log(
    `BALANCE | ${wallet.address.slice(0, 10)}... | MATIC: ${ethers.formatEther(
      matic
    )} | USDC: ${Number(bal) / 1e6}`
  );
}

/* ================= PATHS ================= */

function paths(token) {
  return [
    [USDC.addr, token],
    [token, USDC.addr]
  ];
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  const res = await safeRpc(() =>
    routerContracts[router].getAmountsOut(amount, path)
  );

  return res ? BigInt(res.at(-1).toString()) : null;
}

/* ================= PROFIT SAFE (NO FLOATS EVER) ================= */

function safeProfit(out) {
  if (!out) return 0n;
  return out;
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, tokenAddr) {
  console.log(`CHECK ${buy} -> ${sell}`);

  for (const p of paths(tokenAddr)) {
    const out = await quote(buy, TRADE_AMOUNT, p);
    if (!out) continue;

    const back = await quote(sell, out, p);
    if (!back) continue;

    const profit = safeProfit(back) - TRADE_AMOUNT;

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
        tasks.push({
          buy,
          sell,
          token: token.addr
        });
      }
    }
  }

  return tasks;
}

/* ================= WORKER ================= */

async function worker(chunk, id) {
  let local = 0n;

  for (const t of chunk) {
    const profit = await findTrade(t.buy, t.sell, t.token);

    if (!profit) {
      console.log(`W${id} NO TRADE`);
      continue;
    }

    local += profit;

    console.log(`W${id} TRADE | ${profit}`);

    if (local >= MIN_BATCH_PROFIT) {
      runningProfit += local;

      console.log(
        `W${id} FLUSH | ${local} | TOTAL ${runningProfit}`
      );

      local = 0n;
    }
  }
}

/* ================= LOOP ================= */

async function scanLoop() {
  while (true) {
    console.log("\nNEW SCAN (BATCH MODE)");

    await logBalances();

    const tasks = buildTasks();
    const size = Math.ceil(tasks.length / 10);

    const chunks = [];
    for (let i = 0; i < tasks.length; i += size) {
      chunks.push(tasks.slice(i, i + size));
    }

    await Promise.all(chunks.map((c, i) => worker(c, i)));

    console.log("SCAN COMPLETE → RESTARTING...\n");
  }
}

/* ================= START ================= */

(async () => {
  await init();
  await scanLoop();
})();
