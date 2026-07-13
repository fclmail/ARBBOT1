🛠️⚡🛠️ RUNNING TOTAL& LOGS 



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

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.000001", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.004", 6);

const WORKER_COUNT = 16;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const contractAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
  "function minimumProfitUSDC() view returns(uint256)"
];

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS (RESTORED FULL SET) ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS (RESTORED FULL LIST) ================= */

const TOKENS = {
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
  SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let isExecuting = false;

/* ================= ROUTER CACHE (OPTIMIZATION 1) ================= */

const routerCache = new Map();

function getRouter(addr) {
  if (!routerCache.has(addr)) {
    routerCache.set(
      addr,
      new ethers.Contract(addr, routerAbi, provider)
    );
  }
  return routerCache.get(addr);
}

/* ================= PROVIDER ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

function rebuild() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(USDC, erc20Abi, wallet);

  vault = new ethers.Contract(
    CONTRACT_ADDRESS,
    contractAbi,
    wallet
  );
}

/* ================= INIT ================= */

async function init() {
  provider = newProvider();
  await provider.getNetwork();
  rebuild();

  const min = await vault.minimumProfitUSDC();
  console.log(`ONCHAIN MIN PROFIT ${ethers.formatUnits(min, 6)}\n`);
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  try {
    const out =
      await getRouter(router).getAmountsOut(amount, path);

    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= FULL MULTI-HOP PATHS (RESTORED) ================= */

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

/* ================= FIND TRADE (PARALLEL OPTIMIZED) ================= */

async function findTrade(buy, sell, token) {
  const buyPaths = buildBuyPaths(token);
  const sellPaths = buildSellPaths(token);

  const results = await Promise.all(
    buyPaths.map(async (bp) => {
      const buyOut = await quote(buy, TRADE_AMOUNT, bp);
      if (!buyOut) return null;

      const sells = await Promise.all(
        sellPaths.map(async (sp) => {
          const sellOut = await quote(sell, buyOut, sp);
          if (!sellOut) return null;

          const profit = sellOut - TRADE_AMOUNT;
          if (profit < MIN_PROFIT) return null;

          return {
            buy,
            sell,
            token,
            amountIn: TRADE_AMOUNT,
            buyPath: bp,
            sellPath: sp,
            expectedProfit: profit
          };
        })
      );

      return sells.find(Boolean);
    })
  );

  return results.find(Boolean);
}

/* ================= EXECUTION ================= */

async function executeBatch(trades) {
  console.log("\n================ BATCH EXECUTION ================");

  const beforeWallet = await usdc.balanceOf(wallet.address);
  const beforeContract = await usdc.balanceOf(CONTRACT_ADDRESS);

  console.log(`WALLET BEFORE   ${ethers.formatUnits(beforeWallet, 6)}`);
  console.log(`CONTRACT BEFORE ${ethers.formatUnits(beforeContract, 6)}\n`);

  let usable = [];
  let used = 0n;
  let expected = 0n;

  for (const t of trades) {
    if (used + t.amountIn > beforeContract) break;

    used += t.amountIn;
    expected += t.expectedProfit;
    usable.push(t);
  }

  console.log(`EXECUTING ${usable.length} TRADES`);
  console.log(`EXPECTED PROFIT ${ethers.formatUnits(expected, 6)}\n`);

  const tx = await vault.executeFlashBatchArbitrage({
    buyRouters: usable.map(t => t.buy),
    sellRouters: usable.map(t => t.sell),
    amountsInUSDC: usable.map(t => t.amountIn),
    pathsToToken: usable.map(t => t.buyPath),
    pathsToUSDC: usable.map(t => t.sellPath),
    deadline: Math.floor(Date.now() / 1000) + 30
  });

  console.log(`TX ${tx.hash}`);

  await provider.waitForTransaction(tx.hash);

  const afterContract = await usdc.balanceOf(CONTRACT_ADDRESS);

  console.log("\n================ AFTER ================");
  console.log(`CONTRACT AFTER ${ethers.formatUnits(afterContract, 6)}`);
  console.log(`REAL PROFIT    ${ethers.formatUnits(afterContract - beforeContract, 6)}\n`);

  isExecuting = false;
}

/* ================= WORKERS (16 PARALLEL OPTIMIZED) ================= */

async function worker(id, tasks) {
  while (true) {
    if (isExecuting) continue;

    const batch = [];

    for (let i = 0; i < 5; i++) {
      batch.push(tasks[(id + i) % tasks.length]);
    }

    const results = await Promise.all(
      batch.map(t => findTrade(t.buy, t.sell, t.token))
    );

    for (const r of results) {
      if (!r) continue;

      microTrades.push(r);
      runningProfit += r.expectedProfit;

      console.log(`RUNNING TOTAL ${ethers.formatUnits(runningProfit, 6)}`);
    }

    if (runningProfit >= MIN_BATCH_PROFIT) {
      isExecuting = true;

      const batchCopy = [...microTrades];
      microTrades = [];
      runningProfit = 0n;

      await executeBatch(batchCopy);
    }
  }
}

/* ================= SCAN ================= */

async function scan() {
  const tasks = [];

  for (const b of Object.values(routers)) {
    for (const s of Object.values(routers)) {
      if (b === s) continue;

      for (const t of Object.values(TOKENS)) {
        tasks.push({ buy: b, sell: s, token: t });
      }
    }
  }

  await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, i) =>
      worker(i, tasks)
    )
  );
}

/* ================= MAIN ================= */

(async function main() {
  console.log("🚀 BOT STARTED\n");

  await init();

  const bal = await provider.getBalance(wallet.address);
  console.log(`POL BALANCE ${ethers.formatEther(bal)}\n`);

  await scan();
})();
