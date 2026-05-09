import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE KEY");

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

const BASE_TRADE = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.000001", 6);
const GAS_COST_USDC = ethers.parseUnits("0.00003", 6);

const BATCH_SIZE = 3;

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
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x, 6);

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

/* ================= INIT ================= */

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

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  try {
    const out = await routerContracts[router].getAmountsOut(amount, path);
    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= LIQUIDITY DEPTH PROBING (NEW CORE FEATURE) ================= */

async function probeLiquidityDepth(router, path) {

  const testSizes = [
    BASE_TRADE,
    BASE_TRADE * 5n,
    BASE_TRADE * 10n,
    BASE_TRADE * 25n,
    BASE_TRADE * 50n
  ];

  let maxSafe = BASE_TRADE;

  for (const size of testSizes) {

    const out = await quote(router, size, path);
    if (!out) break;

    const slippage = size > out ? size - out : 0n;

    // reject if slippage exceeds 4%
    const allowed = size * 4n / 100n;

    if (slippage > allowed) break;

    maxSafe = size;
  }

  return maxSafe;
}

/* ================= PATHS ================= */

function buildBuyPaths(token) {
  return [
    [USDC, token],
    [USDC, TOKENS.WETH, token],
    [USDC, TOKENS.WMATIC, token]
  ];
}

function buildSellPaths(token) {
  return [
    [token, USDC],
    [token, TOKENS.WETH, USDC],
    [token, TOKENS.WMATIC, USDC]
  ];
}

/* ================= BEST SIZE (USES LIQUIDITY CAP) ================= */

async function findBestSize(buy, sell, token, buyPath, sellPath) {

  // 🔥 STEP 1: LIQUIDITY DEPTH PROBING BEFORE SCALING
  const safeLimitBuy = await probeLiquidityDepth(buy, buyPath);
  const safeLimitSell = await probeLiquidityDepth(sell, sellPath);

  const maxSafe = safeLimitBuy < safeLimitSell ? safeLimitBuy : safeLimitSell;

  const candidates = [
    BASE_TRADE,
    BASE_TRADE * 3n,
    BASE_TRADE * 10n,
    BASE_TRADE * 25n,
    BASE_TRADE * 50n,
    maxSafe
  ];

  let bestAmount = BASE_TRADE;
  let bestProfit = 0n;

  for (const amt of candidates) {

    if (amt > maxSafe) continue;

    const buyOut = await quote(buy, amt, buyPath);
    if (!buyOut) continue;

    const sellOut = await quote(sell, buyOut, sellPath);
    if (!sellOut) continue;

    const profit = sellOut - amt;

    if (profit > bestProfit) {
      bestProfit = profit;
      bestAmount = amt;
    }
  }

  return { amount: bestAmount, profit: bestProfit };
}

/* ================= TRADE SEARCH ================= */

async function findTrade(token) {

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {

      if (buy === sell) continue;

      for (const bp of buildBuyPaths(token)) {

        const base = await quote(buy, BASE_TRADE, bp);
        if (!base) continue;

        for (const sp of buildSellPaths(token)) {

          const sellOut = await quote(sell, base, sp);
          if (!sellOut) continue;

          const baseProfit = sellOut - BASE_TRADE;
          if (baseProfit <= 0n) continue;

          const best = await findBestSize(buy, sell, token, bp, sp);

          if (best.profit > MIN_PROFIT) {

            console.log(
              `MICRO FOUND ${fmt(baseProfit)} → SIZE ${fmt(best.amount)} → EXPECTED ${fmt(best.profit)}`
            );

            return {
              buy,
              sell,
              amountIn: best.amount,
              buyPath: bp,
              sellPath: sp,
              expectedProfit: best.profit
            };
          }
        }
      }
    }
  }

  return null;
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

  console.log("\n🔥 EXEC BATCH");

  const before = await usdc.balanceOf(CONTRACT_ADDRESS);

  let total = 0n;
  let expected = 0n;

  for (const t of trades) {
    total += t.amountIn;
    expected += t.expectedProfit;
  }

  console.log(`CAPITAL ${fmt(total)}`);
  console.log(`EXPECTED ${fmt(expected)}`);

  if (expected < GAS_COST_USDC) {
    console.log("SKIP: LOW PROFIT\n");
    return;
  }

  const tx = await vault.executeFlashBatchArbitrage({
    buyRouters: trades.map(t => t.buy),
    sellRouters: trades.map(t => t.sell),
    amountsInUSDC: trades.map(t => t.amountIn),
    pathsToToken: trades.map(t => t.buyPath),
    pathsToUSDC: trades.map(t => t.sellPath),
    deadline: Math.floor(Date.now() / 1000) + 30
  });

  await provider.waitForTransaction(tx.hash);

  const after = await usdc.balanceOf(CONTRACT_ADDRESS);

  console.log(`BEFORE ${fmt(before)}`);
  console.log(`AFTER  ${fmt(after)}`);
  console.log(`REAL   ${fmt(after - before)}\n`);
}

/* ================= MAIN ================= */

(async function main() {

  console.log("BOT START\n");

  provider = newProvider();
  rebuildContracts();

  let batch = [];

  setInterval(() => {
    console.log("⏱ scanning...");
  }, 5000);

  while (true) {

    for (const token of Object.values(TOKENS)) {

      const trade = await findTrade(token);

      if (!trade) continue;

      batch.push(trade);

      if (batch.length >= BATCH_SIZE) {
        await executeBatch(batch);
        batch = [];
      }
    }
  }

})();
