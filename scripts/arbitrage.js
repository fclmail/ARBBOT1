import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= SETTINGS ================= */

const MIN_TRADE_USDC = 25;         // realistic trade size
const MIN_EXPECTED_PROFIT = 0.02;  // per trade minimum profit

const SCAN_INTERVAL_MS = 1500;
const DEADLINE_SECONDS = 60;

const MAX_BATCH_SIZE = 20;
const WORKERS = 12;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

const vaultAbi = [
  {
    name: "executeFlashBatchArbitrage",
    type: "function",
    inputs: [
      { name: "buyRouters", type: "address[]" },
      { name: "sellRouters", type: "address[]" },
      { name: "amountsInUSDC", type: "uint256[]" },
      { name: "pathsToToken", type: "address[][]" },
      { name: "pathsToUSDC", type: "address[][]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= USDC ================= */

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const usdcAbi = [
  "function balanceOf(address owner) view returns (uint256)"
];

const usdc = new ethers.Contract(USDC, usdcAbi, provider);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= ROUTER ABI ================= */

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeError(err) {
  return err?.reason || err?.shortMessage || err?.info?.error?.message || err?.message || "Unknown error";
}

/* ================= BALANCE LOGGER ================= */

async function logBalances() {

  const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
  const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);

  const maticBalance = await provider.getBalance(wallet.address);
  const formattedMatic = ethers.formatEther(maticBalance);

  console.log(`${CYAN}Vault USDC Balance:${RESET}`, formattedVaultUSDC);
  console.log(`${CYAN}Wallet MATIC Balance:${RESET}`, formattedMatic);
}

/* ================= QUOTE ================= */

async function quote(routerAddr, amountIn, path) {

  try {

    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);

    return amounts.at(-1);

  } catch (err) {

    console.log(`${YELLOW}Quote failed:${RESET}`, err.message);
    return null;
  }
}

/* ================= FIND TRADE ================= */

async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut;
  let bestBuyPath;

  const buyPaths = [
    [USDC, tokenAddr],
    [USDC, TOKENS.WMATIC, tokenAddr],
    [USDC, TOKENS.WETH, tokenAddr],
    [USDC, TOKENS.USDT, tokenAddr],
    [USDC, TOKENS.DAI, tokenAddr]
  ];

  for (const path of buyPaths) {

    const out = await quote(buyRouter, amountIn, path);

    if (out && (!bestBuyOut || out > bestBuyOut)) {

      bestBuyOut = out;
      bestBuyPath = path;
    }
  }

  if (!bestBuyOut) return null;

  let bestSellOut;
  let bestSellPath;

  const sellPaths = [
    [tokenAddr, USDC],
    [tokenAddr, TOKENS.WMATIC, USDC],
    [tokenAddr, TOKENS.WETH, USDC],
    [tokenAddr, TOKENS.USDT, USDC],
    [tokenAddr, TOKENS.DAI, USDC]
  ];

  for (const path of sellPaths) {

    const out = await quote(sellRouter, bestBuyOut, path);

    if (out && (!bestSellOut || out > bestSellOut)) {

      bestSellOut = out;
      bestSellPath = path;
    }
  }

  if (!bestSellOut) return null;

  const profit =
    Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

  console.log("Trade check profit:", profit);

  if (profit < MIN_EXPECTED_PROFIT) return null;

  return {
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    profit
  };
}

/* ================= REVALIDATE ================= */

async function recalcProfit(trade) {

  const buyOut = await quote(
    trade.buyRouter,
    trade.amountIn,
    trade.bestBuyPath
  );

  if (!buyOut) return 0;

  const sellOut = await quote(
    trade.sellRouter,
    buyOut,
    trade.bestSellPath
  );

  if (!sellOut) return 0;

  return Number(ethers.formatUnits(sellOut, 6)) - MIN_TRADE_USDC;
}

/* ================= MAIN SCANNER ================= */

async function batchArb() {

  await logBalances();

  console.log("---------------------------------------------");
  console.log("SCANNING FOR ARBITRAGE");
  console.log("---------------------------------------------");

  const tasks = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {

      if (buy === sell) continue;

      for (const token of Object.values(TOKENS)) {

        tasks.push(findProfitableTrade(buy, sell, token));
      }
    }
  }

  const batch = [];

  for (let i = 0; i < tasks.length; i += WORKERS) {

    const chunk = tasks.slice(i, i + WORKERS);

    const results = await Promise.all(chunk);

    results.forEach((t) => {
      if (t) batch.push(t);
    });

    if (batch.length >= MAX_BATCH_SIZE) break;
  }

  if (batch.length === 0) {

    console.log("No profitable trades found");
    return;
  }

  console.log(`${GREEN}Batch ready:${RESET}`, batch.length);

/* ================= REVALIDATE ================= */

  const validTrades = [];

  for (const t of batch) {

    const refreshedProfit = await recalcProfit(t);

    if (refreshedProfit >= MIN_EXPECTED_PROFIT) {

      validTrades.push({ ...t, profit: refreshedProfit });
    }
  }

  if (validTrades.length === 0) {

    console.log("All trades invalidated");
    return;
  }

  const expectedProfit =
    validTrades.reduce((acc, t) => acc + t.profit, 0);

  console.log("Expected profit:", expectedProfit);

/* ================= EXECUTE ================= */

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const buyRouters = validTrades.map((t) => t.buyRouter);
  const sellRouters = validTrades.map((t) => t.sellRouter);
  const amountsInUSDC = validTrades.map((t) => t.amountIn);
  const pathsToToken = validTrades.map((t) => t.bestBuyPath);
  const pathsToUSDC = validTrades.map((t) => t.bestSellPath);

  try {

    const estimatedGas =
      await vault.executeFlashBatchArbitrage.estimateGas(
        buyRouters,
        sellRouters,
        amountsInUSDC,
        pathsToToken,
        pathsToUSDC,
        deadline
      );

    const gasLimit = (estimatedGas * 120n) / 100n;

    const tx =
      await vault.executeFlashBatchArbitrage(
        buyRouters,
        sellRouters,
        amountsInUSDC,
        pathsToToken,
        pathsToUSDC,
        deadline,
        { gasLimit }
      );

    console.log(`${GREEN}TX SENT:${RESET}`, tx.hash);

    await tx.wait();

    console.log(`${GREEN}TX CONFIRMED${RESET}`);

    await logBalances();

  } catch (err) {

    console.log(`${RED}Batch failed:${RESET}`, decodeError(err));
  }
}

/* ================= LOOP ================= */

async function main() {

  while (true) {

    await batchArb();

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
