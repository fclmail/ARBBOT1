import dotenv from "dotenv";
import { ethers } from "ethers";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

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
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = 0.02;
const MIN_EXPECTED_PROFIT = 0.000001;

const DEADLINE_SECONDS = 600;
const MAX_BATCH_SIZE = 10000;

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

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

async function logBalances() {
  const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
  const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);
  const maticBalance = await provider.getBalance(wallet.address);
  const formattedMatic = ethers.formatEther(maticBalance);

  console.log(`${CYAN}Vault USDC Balance:${RESET} ${formattedVaultUSDC}`);
  console.log(`${CYAN}Wallet MATIC Balance:${RESET} ${formattedMatic}`);
}

/* ================= WORKER LOGIC ================= */

async function scanWorker(tokens) {

  const opportunities = [];

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  for (const buy of Object.values(routers)) {

    for (const sell of Object.values(routers)) {

      if (buy === sell) continue;

      for (const token of tokens) {

        const buyPath = [TOKENS.USDC, token];
        const sellPath = [token, TOKENS.USDC];

        const buyOut = await quote(buy, amountIn, buyPath);

        if (!buyOut) continue;

        const sellOut = await quote(sell, buyOut, sellPath);

        if (!sellOut) continue;

        const profit =
          Number(ethers.formatUnits(sellOut, 6)) - MIN_TRADE_USDC;

        if (profit >= MIN_EXPECTED_PROFIT) {

          opportunities.push({
            buyRouter: buy,
            sellRouter: sell,
            amountIn,
            bestBuyPath: buyPath,
            bestSellPath: sellPath,
            profit
          });

        }

      }

    }

  }

  return opportunities;

}

/* ================= WORKER THREAD ================= */

if (!isMainThread) {

  (async () => {

    const trades = await scanWorker(workerData.tokens);

    parentPort.postMessage(trades);

  })();

}

/* ================= MAIN THREAD ================= */

if (isMainThread) {

  async function runScanner() {

    await logBalances();

    console.log("Launching parallel scanners...\n");

    console.log("Workers started:", WORKERS);
    console.log("Target batch size:", MAX_BATCH_SIZE);
    console.log("Minimum profit per trade:", MIN_EXPECTED_PROFIT);

    console.log("\nScanning opportunities...\n");

    const tokenList = Object.values(TOKENS);

    const chunkSize = Math.ceil(tokenList.length / WORKERS);

    const chunks = [];

    for (let i = 0; i < WORKERS; i++) {

      chunks.push(
        tokenList.slice(i * chunkSize, (i + 1) * chunkSize)
      );

    }

    const start = Date.now();

    const promises = chunks.map((tokens) => {
      return new Promise((resolve) => {

        const worker = new Worker(new URL(import.meta.url), {
          workerData: { tokens }
        });

        worker.on("message", resolve);

      });
    });

    const results = await Promise.all(promises);

    const opportunities = results.flat();

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

    console.log(`[${elapsed} sec] scanned opportunities`);

    console.log("Trades found:", opportunities.length);

    if (opportunities.length === 0) {
      console.log("No profitable trades found");
      return;
    }

    const batch = opportunities.slice(0, MAX_BATCH_SIZE);

    console.log("---------------------------------------------");
    console.log("BATCH READY");
    console.log("---------------------------------------------");

    console.log("Trades collected:", batch.length);

    const expectedProfit = batch.reduce((a, b) => a + b.profit, 0);

    console.log("Expected profit:", expectedProfit.toFixed(6), "USDC");

  }

  async function main() {

    while (true) {

      await runScanner();

    }

  }

  main();

}
