import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
  "https://polygon-bor-rpc.publicnode.com"
];

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

/* ================= ROUTER HASH MAP ================= */

const routeStats = new Map();

function routeHash(buy, sell, token) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(buy + sell + token)
  ).slice(0, 6); // short hash like a91x
}

function logTradeMerge(hash) {
  const prev = routeStats.get(hash) || 0;
  const next = prev + 1;
  routeStats.set(hash, next);

  if (prev === 0) {
    console.log(`ADDING TRADE ROUTE_HASH ${hash}`);
  } else {
    console.log(`ADDING TRADE ROUTE_HASH ${hash} (MERGED x${next})`);
  }
}

/* ================= TOKENS ================= */

const TOKENS = {
  AAVE:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  APE:"0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV:"0x172370d5cd63279efa6d502dab29171933a610af",
  DAI:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  LINK:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  QUICK:"0x831753dd7087cac61ab5644b308642cc1c33dc13",
  SHIB:"0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
  UNI:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn:"0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird:"0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap:"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:"0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
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
    Object.values(routers).map(a => [
      a,
      new ethers.Contract(
        a,
        ["function getAmountsOut(uint,address[]) view returns(uint[])"],
        provider
      )
    ])
  );
}

/* ================= FIND TRADE (SIMPLIFIED MOCK) ================= */

async function findTrade(buy, sell, token) {

  const hash = routeHash(buy, sell, token);
  logTradeMerge(hash);

  // simulate fast discovery
  const profit = BigInt(1000);

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

/* ================= EXECUTE ================= */

async function executeBatch(batch) {

  console.log("\n🚨 BATCH THRESHOLD REACHED");
  console.log(`REBUILT TRADES ${batch.length}`);

  const grouped = new Map();

  for (const t of batch) {

    const key = t.hash;

    if (!grouped.has(key)) {
      grouped.set(key, { ...t, count: 1 });
    } else {
      const g = grouped.get(key);
      g.count += 1;
      g.expectedProfit += t.expectedProfit;
    }
  }

  console.log("\n📊 MICRO AGGREGATION COMPLETE\n");

  let i = 1;
  let total = 0n;

  const usable = [];

  for (const [k, g] of grouped.entries()) {

    console.log(
      `GROUP ${i} → HASH ${k} | AMOUNT ${ethers.formatUnits(g.amountIn,6)} USDC | PROFIT ${ethers.formatUnits(g.expectedProfit,6)} | MERGED x${g.count}`
    );

    usable.push(g);
    total += g.expectedProfit;
    i++;
  }

  console.log(`\nTOTAL EXPECTED PROFIT ${ethers.formatUnits(total,6)} USDC\n`);

  console.log("🚀 EXECUTING AGGREGATED ROUTES");

  const tx = await vault.executeFlashBatchArbitrage({
    buyRouters: usable.map(t => t.buy),
    sellRouters: usable.map(t => t.sell),
    amountsInUSDC: usable.map(t => t.amountIn),
    pathsToToken: [],
    pathsToUSDC: [],
    deadline: Math.floor(Date.now()/1000)+30
  });

  console.log(`\nTX SENT ${tx.hash}\n`);

  await provider.waitForTransaction(tx.hash);

  console.log("✅ EXECUTION COMPLETE\n");

  isExecuting = false;
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
        `RUNNING TOTAL ${ethers.formatUnits(runningProfit,6)} | BATCH ${microTrades.length}/100`
      );

      if (microTrades.length >= 100 && !isExecuting) {

        isExecuting = true;

        const batch = [...microTrades];

        microTrades = [];
        runningProfit = 0n;

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

  console.log("🚀 BOT STARTED WITH ROUTE MERGE LOGIC\n");

  provider = newProvider();
  rebuildContracts();

  await scanLoop();

})();
