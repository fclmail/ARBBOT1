

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

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = 0.02;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10000;
const DEADLINE_SECONDS = 60;
const MAX_BATCH_SIZE = 3;
const WORKERS = 32;

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

/* ================= USDC ABI ================= */
const usdcAbi = [
  "function balanceOf(address owner) view returns (uint256)"
];

const usdc = new ethers.Contract(
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  usdcAbi,
  provider
);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

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
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeError(err) {
  return err?.reason || err?.shortMessage || err?.info?.error?.message || err?.message || "Unknown error";
}

async function logBalances() {
  const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
  const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);
  const maticBalance = await provider.getBalance(wallet.address);
  const formattedMatic = ethers.formatEther(maticBalance);

  console.log(`${CYAN}Vault USDC Balance:${RESET} ${formattedVaultUSDC}`);
  console.log(`${CYAN}Wallet MATIC Balance:${RESET} ${formattedMatic}`);
}

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {
  const usdcAddr = TOKENS.USDC;
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut, bestBuyPath;
  for (const p of [
    [usdcAddr, tokenAddr],
    [usdcAddr, TOKENS.WMATIC, tokenAddr],
    [usdcAddr, TOKENS.WETH, tokenAddr],
    [usdcAddr, TOKENS.USDT, tokenAddr],
    [usdcAddr, TOKENS.DAI, tokenAddr]
  ]) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyOut) return null;

  let bestSellOut, bestSellPath;
  for (const p of [
    [tokenAddr, usdcAddr],
    [tokenAddr, TOKENS.WMATIC, usdcAddr],
    [tokenAddr, TOKENS.WETH, usdcAddr],
    [tokenAddr, TOKENS.USDT, usdcAddr],
    [tokenAddr, TOKENS.DAI, usdcAddr]
  ]) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }
  if (!bestSellOut) return null;

  const profit = Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;
  if (profit < MIN_EXPECTED_PROFIT) return null;

  return { buyRouter, sellRouter, amountIn, bestBuyPath, bestSellPath, profit };
}

/* ================= REVALIDATION ================= */
async function recalcProfit(trade) {
  const buyOut = await quote(trade.buyRouter, trade.amountIn, trade.bestBuyPath);
  if (!buyOut) return 0;
  const sellOut = await quote(trade.sellRouter, buyOut, trade.bestSellPath);
  if (!sellOut) return 0;
  return Number(ethers.formatUnits(sellOut, 6)) - MIN_TRADE_USDC;
}

/* ================= PARALLEL BATCH ================= */
async function batchArb() {
  await logBalances();

  console.log("Launching parallel scanners ...");
  console.log(`Workers started: ${WORKERS}`);
  console.log(`Target batch size: ${MAX_BATCH_SIZE}`);
  console.log(`Minimum profit per trade: ${MIN_EXPECTED_PROFIT}`);
  console.log(`Expected minimum profit: 0.0002`);
  console.log("---------------------------------------------");
  console.log("SCANNING FOR ARBITRAGE OPPORTUNITIES");
  console.log("---------------------------------------------");

  const startTime = Date.now();
  let totalTradesCollected = 0;

  const tradeTasks = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;
      for (const token of Object.values(TOKENS)) {
        tradeTasks.push(findProfitableTrade(buy, sell, token));
      }
    }
  }

  // Process in parallel chunks of WORKERS
  const chunkedTasks = [];
  for (let i = 0; i < tradeTasks.length; i += WORKERS) {
    chunkedTasks.push(tradeTasks.slice(i, i + WORKERS));
  }

  const batch = [];
  for (const chunk of chunkedTasks) {
    const results = await Promise.all(chunk);
    results.forEach((t) => {
      if (t) batch.push(t);
    });

    totalTradesCollected += results.filter((t) => t).length;
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const avgRate = (totalTradesCollected / ((Date.now() - startTime) / 1000)).toFixed(2);
    console.log(`[${elapsedSec} sec] Trades collected: ${totalTradesCollected} Average rate: ${avgRate} trades/sec`);

    if (batch.length >= MAX_BATCH_SIZE) break;
  }

  if (batch.length === 0) return console.log("No profitable trades found");

  console.log("---------------------------------------------");
  console.log("BATCH READY");
  console.log("---------------------------------------------");
  console.log(`Trades collected: ${batch.length}`);

  // Revalidation
  console.log("Revalidating trades...");
  let removedTrades = 0;
  const validTrades = [];
  for (const t of batch) {
    const refreshedProfit = await recalcProfit(t);
    if (refreshedProfit >= MIN_EXPECTED_PROFIT) validTrades.push({ ...t, profit: refreshedProfit });
    else removedTrades++;
  }

  console.log("Trades removed:", removedTrades);
  console.log("Valid trades remaining:", validTrades.length);

  // Expected profit
  let expectedProfit = validTrades.reduce((acc, t) => acc + t.profit, 0);
  console.log("Recalculating expected profit...");
  console.log("Expected profit:", expectedProfit.toFixed(6), "USDC");
  console.log("Minimum required:", MIN_EXPECTED_PROFIT.toFixed(6), "USDC");

  if (expectedProfit <= MIN_EXPECTED_PROFIT) {
    console.log("Batch rejected: profit below minimum");
    return;
  }

  console.log("Simulation passed");
  console.log("Preparing batch transaction...");

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const buyRouters = validTrades.map((t) => t.buyRouter);
  const sellRouters = validTrades.map((t) => t.sellRouter);
  const amountsInUSDC = validTrades.map((t) => t.amountIn);
  const pathsToToken = validTrades.map((t) => t.bestBuyPath);
  const pathsToUSDC = validTrades.map((t) => t.bestSellPath);

  // ===== GAS DISPLAY =====
  const estimatedGas = await vault.executeFlashBatchArbitrage.estimateGas(
    buyRouters, sellRouters, amountsInUSDC, pathsToToken, pathsToUSDC, deadline
  );
  const gasLimit = (estimatedGas * 120n) / 100n;
  const gasPrice = await provider.getGasPrice();
  const gasCostMATIC = Number(ethers.formatEther(gasPrice * estimatedGas));
  const gasCostUSDC = gasCostMATIC * 0.1;

  console.log("---------------------------------------------");
  console.log(`Estimated Gas: ${estimatedGas}`);
  console.log(`Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`Estimated Gas Cost: ${gasCostMATIC.toFixed(6)} MATIC`);
  console.log(`Estimated Gas Cost in USDC: ${gasCostUSDC.toFixed(6)} USDC`);
  console.log("---------------------------------------------");

  try {
    const tx = await vault.executeFlashBatchArbitrage(
      buyRouters, sellRouters, amountsInUSDC, pathsToToken, pathsToUSDC, deadline, { gasLimit }
    );

    console.log(`${GREEN}Batch flash sent:${RESET}`, tx.hash);
    await tx.wait();
    console.log(`${GREEN}Batch flash confirmed${RESET}`);
    await logBalances();
  } catch (err) {
    console.log(`${RED}Batch trade failed:${RESET}`, decodeError(err));
  }
}

/* ================= MAIN LOOP ================= */
async function main() {
  while (true) {
    await batchArb();
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
