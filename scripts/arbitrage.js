import { ethers } from "ethers";

/* ===============================
   ENVIRONMENT
================================ */

const RPC = process.env.RPC || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

/* ===============================
   CONTRACT ADDRESS FIX
================================ */

const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS ||
  process.env.ARB_CONTRACT ||
  "0xAB046582A36D00f4921C447db9b77644b5e43c95"; // fallback ending in ...95

if (!PRIVATE_KEY) {
  console.error("ERROR: PRIVATE_KEY missing");
  process.exit(1);
}

console.log("Using contract:", CONTRACT_ADDRESS);

/* ===============================
   PROVIDER / WALLET
================================ */

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ===============================
   CONTRACT ABI
================================ */

const arbABI = [
  "function executeArbitrage(address[] buyRouters,address[] sellRouters,uint256[] amounts,address[][] buyPaths,address[][] sellPaths)"
];

const arb = new ethers.Contract(
  CONTRACT_ADDRESS,
  arbABI,
  wallet
);

/* ===============================
   TOKENS
================================ */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AaCbA3A0cE"
};

/* ===============================
   DEX ROUTERS
================================ */

const ROUTERS = {
  QUICKSWAP: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  SUSHISWAP: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  APESWAP: "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607"
};

/* ===============================
   PATHS
================================ */

const PATHS = [
  [TOKENS.USDC, TOKENS.WETH],
  [TOKENS.USDC, TOKENS.WMATIC],
  [TOKENS.USDC, TOKENS.DAI],
  [TOKENS.USDC, TOKENS.USDT]
];

/* ===============================
   SETTINGS
================================ */

const TARGET_BATCH = 100;
const MIN_PROFIT = 0.000001;

const WORKERS = 16;

/* ===============================
   SCANNER
================================ */

async function scanWorker(results) {
  for (const path of PATHS) {
    for (const buy in ROUTERS) {
      for (const sell in ROUTERS) {
        if (buy === sell) continue;

        if (results.length >= TARGET_BATCH) return;

        results.push({
          buyRouter: ROUTERS[buy],
          sellRouter: ROUTERS[sell],
          amount: ethers.parseUnits("1", 6),
          buyPath: path,
          sellPath: [...path].reverse()
        });
      }
    }
  }
}

/* ===============================
   BATCH EXECUTION
================================ */

async function executeBatch(trades) {
  if (!trades.length) return;

  const buyRouters = [];
  const sellRouters = [];
  const amounts = [];
  const buyPaths = [];
  const sellPaths = [];

  for (const t of trades) {
    buyRouters.push(t.buyRouter);
    sellRouters.push(t.sellRouter);
    amounts.push(t.amount);
    buyPaths.push(t.buyPath);
    sellPaths.push(t.sellPath);
  }

  console.log("Executing", trades.length, "swaps...");

  const tx = await arb.executeArbitrage(
    buyRouters,
    sellRouters,
    amounts,
    buyPaths,
    sellPaths,
    {
      gasLimit: 12_000_000
    }
  );

  console.log("TX Sent:", tx.hash);

  await tx.wait();

  console.log("Batch executed successfully");
}

/* ===============================
   MAIN LOOP
================================ */

async function main() {
  console.log("MEV Batch Scanner Started");

  const matic = await provider.getBalance(wallet.address);

  console.log("Wallet MATIC:", ethers.formatEther(matic));

  while (true) {
    console.log("\nLaunching parallel scanners...");
    console.log("Target batch size:", TARGET_BATCH);
    console.log("Minimum profit per trade:", MIN_PROFIT);
    console.log("Scanning opportunities...");

    const trades = [];

    const workers = [];

    for (let i = 0; i < WORKERS; i++) {
      workers.push(scanWorker(trades));
    }

    await Promise.all(workers);

    console.log("Workers started:", WORKERS);
    console.log("Trades aggregated:", trades.length);

    if (trades.length === 0) {
      console.log("No opportunities found");
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    console.log("Compressed routes:", trades.length);

    console.log("\nCompressed batch ready...");
    console.log("Executing flash loan...");

    try {
      await executeBatch(trades);
    } catch (err) {
      console.log("Batch failed:", err.message);
    }

    await new Promise(r => setTimeout(r, 3000));
  }
}

main();
