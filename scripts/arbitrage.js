type h```js
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE KEY");

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

/* ================= RPC ================= */

const RPCS = [
  "https://polygon-mainnet.core.chainstack.com/46058733cb4d6319063e68f8673791a8",
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon"
];

let rpcIndex = 0;
let provider;
let wallet;

/* ================= TOKENS ================= */

const USDC = {
  addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  decimals: 6
};

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

const contractAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)"
];

/* ================= STATE ================= */

const TRADE_AMOUNT = 10n * 10n ** 6n; // 10 USDC
const MIN_PROFIT = 50n;               // 0.00005 USDC
const MIN_BATCH_PROFIT = 200n;

let routerContracts = {};
let usdcContract;
let arbContract;

let runningProfit = 0n;

/* ================= FORMATTERS ================= */

function formatUSDC(raw) {
  return (Number(raw) / 1e6).toFixed(6);
}

/* ================= RPC ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;

  console.log(`ACTIVE RPC -> ${url}`);
  return new ethers.JsonRpcProvider(url);
}

function rebuild() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  for (const [name, addr] of Object.entries(routers)) {
    routerContracts[name] = new ethers.Contract(
      addr,
      routerAbi,
      provider
    );
  }

  usdcContract = new ethers.Contract(
    USDC.addr,
    erc20Abi,
    provider
  );

  arbContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    contractAbi,
    wallet
  );
}

async function init() {
  provider = newProvider();
  await provider.getNetwork();
  rebuild();

  console.log(`WALLET -> ${wallet.address.slice(0, 8)}...`);
}

/* ================= SAFE RPC ================= */

async function safeRpc(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
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
    `\nBALANCE | ${wallet.address.slice(0, 10)}... | ` +
    `MATIC: ${ethers.formatEther(matic)} | ` +
    `USDC: ${formatUSDC(bal)}\n`
  );
}

/* ================= PATH BUILDER ================= */

function buildPaths(token) {
  return {
    forward: [USDC.addr, token],
    backward: [token, USDC.addr]
  };
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  const res = await safeRpc(() =>
    routerContracts[router].getAmountsOut(amount, path)
  );

  return res ? BigInt(res.at(-1).toString()) : null;
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, token) {
  console.log(`CHECK ${buy} -> ${sell}`);

  const { forward, backward } = buildPaths(token);

  const tokenOut = await quote(buy, TRADE_AMOUNT, forward);
  if (!tokenOut) return null;

  const usdcBack = await quote(sell, tokenOut, backward);
  if (!usdcBack) return null;

  const profit = usdcBack - TRADE_AMOUNT;

  if (profit > MIN_PROFIT) {
    console.log(
      `ARB FOUND | ${buy} -> ${sell} | ` +
      `IN: ${formatUSDC(TRADE_AMOUNT)} | ` +
      `OUT: ${formatUSDC(usdcBack)} | ` +
      `PROFIT: ${formatUSDC(profit)}`
    );

    return {
      profit,
      token,
      buy,
      sell,
      forward,
      backward
    };
  }

  return null;
}

/* ================= WORKER ================= */

async function worker(tasks, id) {
  let local = 0n;

  for (const t of tasks) {
    const result = await findTrade(
      t.buy,
      t.sell,
      t.token
    );

    if (!result) {
      console.log(`W${id} NO TRADE`);
      continue;
    }

    local += result.profit;

    console.log(
      `W${id} TRADE | PROFIT: ${formatUSDC(result.profit)} USDC`
    );

    if (local >= MIN_BATCH_PROFIT) {
      runningProfit += local;

      console.log(
        `W${id} FLUSH | ${formatUSDC(local)} | TOTAL ${formatUSDC(runningProfit)}`
      );

      local = 0n;
    }
  }
}

/* ================= TASK BUILDER ================= */

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
    console.log("\nNEW SCAN (BATCH MODE)\n");

    await logBalances();

    const tasks = buildTasks();
    const size = Math.ceil(tasks.length / 2);

    const chunks = [];
    for (let i = 0; i < tasks.length; i += size) {
      chunks.push(tasks.slice(i, i + size));
    }

    await Promise.all(
      chunks.map((c, i) => worker(c, i))
    );

    console.log("\nSCAN COMPLETE → RESTARTING...\n");
  }
}

/* ================= START ================= */

(async () => {
  await init();
  await scanLoop();
})();
```
ere
