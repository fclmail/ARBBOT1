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
const TARGET_BATCH_SIZE = 100;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
"0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
"function balanceOf(address) view returns(uint256)",
"function approve(address,uint256)"
];

const contractAbi = [
"function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const routerAbi = [
"function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS ================= */

const routers = {
QuickSwap:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
SushiSwap:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
ApeSwap:"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= TOKENS ================= */

const TOKENS = {
WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let executionLock = false;

/* ================= PROVIDER ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(USDC, erc20Abi, wallet);
  vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

  routerContracts = Object.fromEntries(
    Object.values(routers).map(a => [
      a,
      new ethers.Contract(a, routerAbi, provider)
    ])
  );
}

/* ================= BALANCE LOGS ================= */

async function logBalances(label) {
  const contractUSDC = await usdc.balanceOf(CONTRACT_ADDRESS);
  const walletMATIC = await provider.getBalance(wallet.address);

  console.log(`\n💰 ${label}`);
  console.log(`CONTRACT USDC: ${ethers.formatUnits(contractUSDC, 6)}`);
  console.log(`WALLET MATIC:  ${ethers.formatEther(walletMATIC)}`);
}

/* ================= PATHS ================= */

function buildBuyPaths(token) {
  return [
    [USDC, token],
    [USDC, TOKENS.WETH, token],
    [USDC, TOKENS.WMATIC, token],
    [USDC, TOKENS.USDT, token]
  ];
}

function buildSellPaths(token) {
  return [
    [token, USDC],
    [token, TOKENS.WETH, USDC],
    [token, TOKENS.WMATIC, USDC],
    [token, TOKENS.USDT, USDC]
  ];
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, token) {
  for (const bp of buildBuyPaths(token)) {
    const buyOut =
      await routerContracts[buy].getAmountsOut(TRADE_AMOUNT, bp).catch(() => null);

    if (!buyOut) continue;

    for (const sp of buildSellPaths(token)) {
      const sellOut =
        await routerContracts[sell].getAmountsOut(buyOut.at(-1), sp).catch(() => null);

      if (!sellOut) continue;

      const profit = sellOut.at(-1) - TRADE_AMOUNT;

      if (profit < MIN_PROFIT) continue;

      return {
        buy,
        sell,
        token,
        amountIn: TRADE_AMOUNT,
        expectedProfit: profit
      };
    }
  }

  return null;
}

/* ================= REBUILD ================= */

async function rebuildBatch(batch) {
  console.log("\n🔁 FULL BATCH REBUILD START");

  const valid = [];

  for (const t of batch) {
    const buyOut =
      await routerContracts[t.buy]
        .getAmountsOut(t.amountIn, [USDC, TOKENS.WMATIC])
        .catch(() => null);

    if (!buyOut) continue;

    const sellOut =
      await routerContracts[t.sell]
        .getAmountsOut(buyOut.at(-1), [TOKENS.WMATIC, USDC])
        .catch(() => null);

    if (!sellOut) continue;

    const profit = sellOut.at(-1) - t.amountIn;

    if (profit < MIN_PROFIT) continue;

    t.expectedProfit = profit;
    valid.push(t);
  }

  console.log(`VALID AFTER REBUILD: ${valid.length}/${batch.length}`);
  return valid;
}

/* ================= EXECUTION ================= */

async function executeBatch(batch) {
  executionLock = true;

  await logBalances("BEFORE EXECUTION");

  const rebuilt = await rebuildBatch(batch);

  rebuilt.sort((a, b) =>
    b.expectedProfit > a.expectedProfit ? 1 : -1
  );

  const totalProfit = rebuilt.reduce((a, b) => a + b.expectedProfit, 0n);

  console.log("\n🚀 EXECUTING FINAL BATCH");
  console.log(`TRADES: ${rebuilt.length}`);
  console.log(`EXPECTED PROFIT: ${ethers.formatUnits(totalProfit, 6)}`);

  // simulate tx
  console.log("TX SENT");

  await logBalances("AFTER EXECUTION");

  console.log("♻️ BATCH COMPLETE\n");

  microTrades = [];
  runningProfit = 0n;
  executionLock = false;
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
      if (executionLock) continue;

      const task = tasks[i++ % tasks.length];

      const trade = await findTrade(task.buy, task.sell, task.token);
      if (!trade) continue;

      microTrades.push(trade);
      runningProfit += trade.expectedProfit;

      console.log(
        `RUNNING TOTAL ${ethers.formatUnits(runningProfit, 6)} | BATCH ${microTrades.length}/${TARGET_BATCH_SIZE}`
      );

      /* ================= EXEC TRIGGER ================= */

      if (
        !executionLock &&
        microTrades.length >= TARGET_BATCH_SIZE
      ) {
        console.log("\n🚨 TARGET BATCH SIZE REACHED");

        const snapshot = [...microTrades];

        microTrades = [];
        runningProfit = 0n;

        await executeBatch(snapshot);
      }
    }
  }

  await Promise.all(Array.from({ length: WORKER_COUNT }, worker));
}

/* ================= MAIN ================= */

(async function main() {
  console.log("BOT STARTED");
  provider = newProvider();
  rebuildContracts();
  await scanLoop();
})();
