import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

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
const WORKER_COUNT = 8;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

/* ✅ ONLY VESTIGIAL FLASH REMOVED */
const contractAbi = [
  "function triggerFlashArbitrage((address routerBuy,address routerSell,address token) route,uint256 amountIn,uint256 minimumExpectedProfit)",
  "function minimumProfitUSDC() view returns(uint256)"
];

/* ================= ROUTER ABI ================= */

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= TOKENS ================= */
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

let runningProfit = 0n;
let isExecuting = false;

/* ================= PROVIDER ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

/* ================= INIT ================= */

async function init() {
  provider = newProvider();
  await provider.getNetwork();

  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(USDC, erc20Abi, wallet);

  vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

  const min = await vault.minimumProfitUSDC();
  console.log("ONCHAIN MIN PROFIT:", ethers.formatUnits(min, 6));
}

/* ================= ROUTER CACHE ================= */

const routerCache = new Map();

function getRouter(addr) {
  if (!routerCache.has(addr)) {
    routerCache.set(addr, new ethers.Contract(addr, routerAbi, provider));
  }
  return routerCache.get(addr);
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  try {
    const out = await getRouter(router).getAmountsOut(amount, path);
    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= PATH BUILDERS ================= */

function buildPaths(token) {
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

/* ================= TRADE FIND ================= */

async function findTrade(buy, sell, token) {
  const buyPaths = buildPaths(token);
  const sellPaths = buildSellPaths(token);

  let best = null;

  for (const bp of buyPaths) {
    const buyOut = await quote(buy, TRADE_AMOUNT, bp);
    if (!buyOut) continue;

    for (const sp of sellPaths) {
      const sellOut = await quote(sell, buyOut, sp);
      if (!sellOut) continue;

      const profit = sellOut - TRADE_AMOUNT;

      if (profit < MIN_PROFIT) continue;

      if (!best || profit > best.expectedProfit) {
        best = {
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
  }

  return best;
}

/* ================= EXECUTION (VAULT ONLY) ================= */

async function executeTrade(trade) {
  try {
    console.log("\n⚡ EXECUTING VAULT TRADE");
    console.log("Token:", trade.token);

    const tx = await vault.triggerFlashArbitrage(
      {
        routerBuy: trade.buy,
        routerSell: trade.sell,
        token: trade.token
      },
      trade.amountIn,
      MIN_PROFIT
    );

    console.log("TX SENT:", tx.hash);

    const receipt = await provider.waitForTransaction(tx.hash);

    console.log("CONFIRMED BLOCK:", receipt.blockNumber);
  } catch (e) {
    console.log("❌ EXECUTION FAILED:", e.message);
  }
}

/* ================= WORKER ================= */

async function worker(id, tasks) {
  while (true) {
    if (isExecuting) {
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    await new Promise(r => setTimeout(r, 100));

    const batch = tasks.slice(0, 6);

    const results = await Promise.all(
      batch.map(t => findTrade(t.buy, t.sell, t.token))
    );

    for (const r of results) {
      if (!r) continue;

      runningProfit += r.expectedProfit;

      console.log(
        `[W${id}] RUNNING PROFIT: ${ethers.formatUnits(runningProfit, 6)}`
      );

      // EXECUTE IMMEDIATELY (NO FLASH LOAN, NO BATCH)
      if (r.expectedProfit >= MIN_PROFIT && !isExecuting) {
        isExecuting = true;

        await executeTrade(r);

        runningProfit = 0n;
        isExecuting = false;
      }
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

  console.log("TOTAL PAIRS:", tasks.length);

  await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, i) =>
      worker(i, tasks)
    )
  );
}

/* ================= MAIN ================= */

(async function main() {
  console.log("🚀 VAULT ARBITRAGE BOT (NO FLASH LOAN)\n");

  await init();

  const bal = await provider.getBalance(wallet.address);
  console.log("WALLET:", wallet.address);
  console.log("POL BALANCE:", ethers.formatEther(bal), "\n");

  await scan();
})();
