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
const DEADLINE_SECONDS = 6000;

const TARGET_BATCH_SIZE = 1000;
const WORKERS = 16;

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
  return (
    err?.reason ||
    err?.shortMessage ||
    err?.info?.error?.message ||
    err?.message ||
    "Unknown error"
  );
}

async function logBalances() {
  const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
  const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);
  const maticBalance = await provider.getBalance(wallet.address);
  const formattedMatic = ethers.formatEther(maticBalance);

  console.log(`${CYAN}Vault USDC:${RESET} ${formattedVaultUSDC}`);
  console.log(`${CYAN}Wallet MATIC:${RESET} ${formattedMatic}`);
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

/* ================= FIND TRADE ================= */
async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {
  if (tokenAddr === TOKENS.USDC) return null;

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);
  let bestBuyOut, bestBuyPath;

  const buyPaths = [
    [TOKENS.USDC, tokenAddr],
    [TOKENS.USDC, TOKENS.WMATIC, tokenAddr],
    [TOKENS.USDC, TOKENS.WETH, tokenAddr],
    [TOKENS.USDC, TOKENS.USDT, tokenAddr],
    [TOKENS.USDC, TOKENS.DAI, tokenAddr]
  ];

  for (const p of buyPaths) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestBuyOut) return null;

  let bestSellOut, bestSellPath;

  const sellPaths = [
    [tokenAddr, TOKENS.USDC],
    [tokenAddr, TOKENS.WMATIC, TOKENS.USDC],
    [tokenAddr, TOKENS.WETH, TOKENS.USDC],
    [tokenAddr, TOKENS.USDT, TOKENS.USDC],
    [tokenAddr, TOKENS.DAI, TOKENS.USDC]
  ];

  for (const p of sellPaths) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }

  if (!bestSellOut) return null;

  const profit = Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;
  if (profit < MIN_EXPECTED_PROFIT) return null;

  return { buyRouter, sellRouter, amountIn, bestBuyPath, bestSellPath };
}

/* ================= PARALLEL SCAN ================= */
async function parallelScan() {
  console.log(`${CYAN}Launching parallel scanners...${RESET}`);
  console.log(`Workers started: ${WORKERS}`);

  const tasks = [];
  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;
      for (const token of Object.values(TOKENS)) tasks.push({ buy, sell, token });
    }
  }

  let index = 0;
  const profitable = [];

  async function worker() {
    while (index < tasks.length) {
      const t = tasks[index++];
      const trade = await findProfitableTrade(t.buy, t.sell, t.token);
      if (trade) profitable.push(trade);
    }
  }

  const workers = [];
  for (let i = 0; i < WORKERS; i++) workers.push(worker());
  await Promise.all(workers);

  // return only up to TARGET_BATCH_SIZE
  return profitable.slice(0, TARGET_BATCH_SIZE);
}

/* ================= COMPRESSION ================= */
function compressTrades(trades) {
  const map = new Map();
  for (const t of trades) {
    const key = t.buyRouter + t.sellRouter + t.bestBuyPath.join("") + t.bestSellPath.join("");
    if (!map.has(key)) map.set(key, { trade: t, repeat: 0 });
    map.get(key).repeat++;
  }
  return [...map.values()];
}

/* ================= EXPAND ================= */
function expandTrades(compressed) {
  const expanded = [];
  for (const r of compressed) {
    for (let i = 0; i < r.repeat; i++) expanded.push(r.trade);
  }
  return expanded;
}

/* ================= EXECUTION ================= */
async function batchArb() {
  await logBalances();

  console.log(`
Launching parallel scanners...
Target batch size: ${TARGET_BATCH_SIZE}
Minimum profit per trade: ${MIN_EXPECTED_PROFIT}
Scanning opportunities...
`);

  const profitableTrades = await parallelScan();

  if (profitableTrades.length === 0) {
    console.log("No profitable trades found");
    return;
  }

  console.log(`Trades aggregated: ${profitableTrades.length}`);

  const compressed = compressTrades(profitableTrades);
  console.log(`Compressed routes: ${compressed.length}`);

  const expanded = expandTrades(compressed);

  console.log(`
Compressed batch ready...
Executing flash loan...
Executing ${expanded.length} swaps...
`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const buyRouters = expanded.map(t => t.buyRouter);
  const sellRouters = expanded.map(t => t.sellRouter);
  const amountsInUSDC = expanded.map(t => t.amountIn);
  const pathsToToken = expanded.map(t => t.bestBuyPath);
  const pathsToUSDC = expanded.map(t => t.bestSellPath);

  try {
    await vault.executeFlashBatchArbitrage.staticCall(
      buyRouters, sellRouters, amountsInUSDC, pathsToToken, pathsToUSDC, deadline
    );

    const gas = await vault.executeFlashBatchArbitrage.estimateGas(
      buyRouters, sellRouters, amountsInUSDC, pathsToToken, pathsToUSDC, deadline
    );

    const tx = await vault.executeFlashBatchArbitrage(
      buyRouters, sellRouters, amountsInUSDC, pathsToToken, pathsToUSDC, deadline,
      { gasLimit: (gas * 120n) / 100n }
    );

    console.log(`${GREEN}Transaction sent:${RESET}`, tx.hash);
    await tx.wait();
    console.log(`${GREEN}Transaction confirmed${RESET}`);
    await logBalances();

  } catch (err) {
    console.log(`${RED}Batch failed:${RESET}`, decodeError(err));
  }
}

/* ================= LOOP ================= */
async function main() {
  console.log(`${GREEN}MEV Batch Scanner Started${RESET}`);
  while (true) {
    await batchArb();
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
