import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PK missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONFIG ================= */

const TRADE_AMOUNT_USDC = 0.02;
const MIN_PROFIT_USDC = 0.0001;
const MAX_BATCH_SIZE = 100;
const DEADLINE_SECONDS = 60;
const SCAN_INTERVAL_MS = 500;
const REPEAT_PROFITABLE_TX = 3;
const TARGET_PROFIT_USDC = 0.01; // Stop batch when total profit reaches this

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xC1888f15C47e79E45342Dea9249622476A83563f";

const vaultAbi = [
  {
    name: "executeFlashBatchArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "batch",
        type: "tuple",
        components: [
          { name: "buyRouters", type: "address[]" },
          { name: "sellRouters", type: "address[]" },
          { name: "amountsInUSDC", type: "uint256[]" },
          { name: "pathsToToken", type: "address[][]" },
          { name: "pathsToUSDC", type: "address[][]" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
  },
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= USDC ================= */

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const usdc = new ethers.Contract(
  USDC,
  ["function balanceOf(address) view returns(uint256)"],
  wallet
);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef",
};

const routerAbi = ["function getAmountsOut(uint,address[]) view returns(uint[])"];

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  FRAX: "0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89",
  MAI: "0xa3Fa99A148fA48D14Ed51d610c367C61876997F1",
  BUSD: "0xdAb529f40e671A1D4BF91361c21bf9F0C9712Ab7",
  TUSD: "0x2e1AD108fF1D8C782fcBbB89AAd783aC49586756",
  UNI: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
  SUSHI: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a",
  QUICK: "0x831753DD7087CaC61aB5644b308642cc1c33Dc13",
  BAL: "0x9a71012B13CA4d3D0Cdc72A177DF3Ef03b0E76A3",
  stMATIC: "0x3A58a54C066FdC0F2D55FC9C89F0415C92eBf3C4",
  wstETH: "0x03b54A6e9a984069379FAe1a4Fc4dBaE93b3bccd",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logBalances() {
  const v = await usdc.balanceOf(VAULT_ADDRESS);
  const m = await provider.getBalance(wallet.address);

  console.log(CYAN, "Vault USDC:", RESET, ethers.formatUnits(v, 6));
  console.log(CYAN, "Wallet MATIC:", RESET, ethers.formatEther(m));
}

async function quote(router, amount, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const a = await r.getAmountsOut(amount, path);
    return a.at(-1);
  } catch {
    return null;
  }
}

/* ================= PATHS ================= */

function buildPaths(token) {
  return [
    [USDC, token],
    [USDC, TOKENS.WETH, token],
    [USDC, TOKENS.WMATIC, token],
    [USDC, TOKENS.DAI, token],
    [USDC, TOKENS.USDT, token],
  ];
}

function buildSell(token) {
  return [
    [token, USDC],
    [token, TOKENS.WETH, USDC],
    [token, TOKENS.WMATIC, USDC],
    [token, TOKENS.DAI, USDC],
    [token, TOKENS.USDT, USDC],
  ];
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
  const buyPaths = buildPaths(token);
  const sellPaths = buildSell(token);

  for (const bp of buyPaths) {
    const buyOut = await quote(buy, amountIn, bp);
    if (!buyOut) continue;

    for (const sp of sellPaths) {
      const sellOut = await quote(sell, buyOut, sp);
      if (!sellOut) continue;

      const profit =
        Number(ethers.formatUnits(sellOut, 6)) -
        Number(ethers.formatUnits(amountIn, 6));

      if (profit < MIN_PROFIT_USDC) continue;

      console.log(GREEN, "PROFIT", RESET, profit.toFixed(6));

      return { buy, sell, amountIn, buyPath: bp, sellPath: sp, profit };
    }
  }
  return null;
}

/* ================= MICRO AGG ================= */

function microAggregate(trades) {
  const map = new Map();
  for (const t of trades) {
    const key = t.buy + t.sell + t.buyPath.join();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }

  const out = [];
  for (const g of map.values()) {
    const t = g[0];
    const total = g.reduce(
      (s, x) => s + Number(ethers.formatUnits(x.amountIn, 6)),
      0
    );
    const profit = g.reduce((s, x) => s + x.profit, 0);

    for (let r = 0; r < REPEAT_PROFITABLE_TX; r++) {
      out.push({
        buy: t.buy,
        sell: t.sell,
        amountIn: ethers.parseUnits(total.toString(), 6),
        buyPath: t.buyPath,
        sellPath: t.sellPath,
        profit,
      });
    }
  }
  return out;
}

/* ================= SIM ================= */

async function simulate(batch) {
  try {
    await vault.executeFlashBatchArbitrage.staticCall(batch);
    return true;
  } catch {
    return false;
  }
}

/* ================= BATCH ================= */

async function batchArb() {
  await logBalances();

  const trades = [];
  let totalProfit = 0;

  while (trades.length < MAX_BATCH_SIZE && totalProfit < TARGET_PROFIT_USDC) {
    const tasks = [];
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        for (const token of Object.values(TOKENS)) {
          tasks.push(findTrade(buy, sell, token));
        }
      }
    }

    const res = await Promise.all(tasks);
    for (const t of res) {
      if (!t) continue;
      trades.push(t);
      totalProfit += t.profit;
      if (totalProfit >= TARGET_PROFIT_USDC) break;
    }

    console.log(YELLOW, "Collected", trades.length, "Total:", totalProfit.toFixed(6), RESET);
  }

  const profitableTrades = trades.filter((t) => t.profit >= MIN_PROFIT_USDC);
  let grouped = microAggregate(profitableTrades);

  if (grouped.length > MAX_BATCH_SIZE) grouped = grouped.slice(0, MAX_BATCH_SIZE);

  console.log("After agg:", grouped.length);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const batch = {
    buyRouters: grouped.map((t) => t.buy),
    sellRouters: grouped.map((t) => t.sell),
    amountsInUSDC: grouped.map((t) => t.amountIn),
    pathsToToken: grouped.map((t) => t.buyPath),
    pathsToUSDC: grouped.map((t) => t.sellPath),
    deadline,
  };

  console.log("Simulating...");
  const ok = await simulate(batch);
  if (!ok) {
    console.log(RED, "SIM FAIL", RESET);
    return;
  }

  try {
    const gas = await vault.executeFlashBatchArbitrage.estimateGas(batch);
    const tx = await vault.executeFlashBatchArbitrage(batch, { gasLimit: (gas * 130n) / 100n });
    console.log(GREEN, "TX", RESET, tx.hash);
    await tx.wait();

    const vaultBalanceAfter = await usdc.balanceOf(VAULT_ADDRESS);
    console.log(GREEN, "CONFIRMED", RESET);
    console.log(CYAN, "Total USDC deposited to vault:", RESET, ethers.formatUnits(vaultBalanceAfter, 6));
  } catch (e) {
    console.log(RED, "FAIL", RESET, e.message);
  }
}

/* ================= LOOP ================= */

async function main() {
  while (true) {
    await batchArb();
    await sleep(SCAN_INTERVAL_MS);
  }
}

main();
