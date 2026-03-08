import "dotenv/config";
import { ethers } from "ethers";

/* ===============================
   PROVIDER + WALLET
================================ */

const provider = new ethers.JsonRpcProvider(process.env.RPC);

const wallet = new ethers.Wallet(
  process.env.PRIVATE_KEY,
  provider
);

/* ===============================
   CONFIG
================================ */

const MAX_BATCH_SIZE = 100;
const WORKERS = 16;
const MIN_EXPECTED_PROFIT = 0.000001;

/* ===============================
   COLORS
================================ */

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

/* ===============================
   TOKENS (Polygon ERC20)
================================ */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",

  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",

  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  BAL: "0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3",
  SUSHI: "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a"
};

/* ===============================
   DEX ROUTERS (Polygon)
================================ */

const routers = {
  quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  jetswap: "0x5C6EC38C3d7C8f7b1c0C0B1C90a55338183B081B",
  dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ===============================
   HOP PATHS
================================ */

const HOPS = [
  [],
  [TOKENS.WETH],
  [TOKENS.WBTC]
];

/* ===============================
   ARBITRAGE CONTRACT
================================ */

const arbABI = [
  "function executeArbitrage(address[] buyRouters,address[] sellRouters,uint256[] amounts,address[][] buyPaths,address[][] sellPaths)"
];

const arb = new ethers.Contract(
  process.env.ARB_CONTRACT,
  arbABI,
  wallet
);

/* ===============================
   PROFIT SCANNER (placeholder)
================================ */

async function findProfitableTrade(buyRouter, sellRouter, token) {

  for (const hop of HOPS) {

    const buyPath = [
      TOKENS.USDC,
      ...hop,
      token
    ];

    const sellPath = [
      token,
      ...hop.slice().reverse(),
      TOKENS.USDC
    ];

    const rand = Math.random();

    if (rand > 0.97) {

      return {
        buyRouter,
        sellRouter,
        amountIn: ethers.parseUnits("10", 6),
        bestBuyPath: buyPath,
        bestSellPath: sellPath
      };

    }
  }

  return null;
}

/* ===============================
   FIX #1 — CONTINUOUS SCAN
================================ */

async function parallelScan() {

  console.log(`${CYAN}Launching parallel scanners...${RESET}`);

  const profitableTrades = [];

  while (profitableTrades.length < MAX_BATCH_SIZE) {

    const tasks = [];

    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {

        if (buy === sell) continue;

        for (const token of Object.values(TOKENS)) {

          if (token === TOKENS.USDC) continue;

          tasks.push({
            buy,
            sell,
            token
          });

        }

      }
    }

    let index = 0;

    async function worker() {

      while (
        index < tasks.length &&
        profitableTrades.length < MAX_BATCH_SIZE
      ) {

        const t = tasks[index++];

        const trade =
          await findProfitableTrade(
            t.buy,
            t.sell,
            t.token
          );

        if (trade) {

          profitableTrades.push(trade);

          console.log(
            `${GREEN}Trade found ${profitableTrades.length}/${MAX_BATCH_SIZE}${RESET}`
          );
        }
      }
    }

    const workers = [];

    for (let i = 0; i < WORKERS; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (profitableTrades.length < MAX_BATCH_SIZE) {

      console.log(
        `${YELLOW}Only ${profitableTrades.length} found. Rescanning...${RESET}`
      );

    }
  }

  return profitableTrades.slice(0, MAX_BATCH_SIZE);
}

/* ===============================
   COMPRESSION
================================ */

function compressTrades(trades) {

  const map = new Map();

  for (const t of trades) {

    const key =
      t.buyRouter +
      "|" +
      t.sellRouter +
      "|" +
      t.bestBuyPath.join("-") +
      "|" +
      t.bestSellPath.join("-");

    if (!map.has(key)) {

      map.set(key, {
        trade: t,
        repeat: 0
      });

    }

    map.get(key).repeat++;
  }

  return [...map.values()];
}

/* ===============================
   EXPAND TRADES
================================ */

function expandTrades(compressed) {

  const expanded = [];

  for (const r of compressed) {

    for (let i = 0; i < r.repeat; i++) {
      expanded.push(r.trade);
    }

  }

  return expanded;
}

/* ===============================
   PRINT ROUTES
================================ */

function printCompressedBatch(routes) {

  console.log(`\n${CYAN}Compressed batch ready...${RESET}`);

  for (const r of routes) {

    console.log(
      `${r.trade.bestBuyPath.at(-1)} repeat ${r.repeat}`
    );

  }
}

/* ===============================
   MAIN BOT LOOP
================================ */

async function run() {

  console.log("MEV Batch Scanner Started\n");

  while (true) {

    try {

      const balance =
        await provider.getBalance(wallet.address);

      console.log(
        `Wallet MATIC: ${ethers.formatEther(balance)}\n`
      );

      console.log("Launching parallel scanners...");
      console.log(`Target batch size: ${MAX_BATCH_SIZE}`);
      console.log(`Minimum profit per trade: ${MIN_EXPECTED_PROFIT}`);
      console.log("Scanning opportunities...\n");

      const profitableTrades =
        await parallelScan();

      console.log(
        `Trades aggregated: ${profitableTrades.length}`
      );

      const compressed =
        compressTrades(profitableTrades);

      console.log(
        `Compressed routes: ${compressed.length}`
      );

      printCompressedBatch(compressed);

      const expanded =
        expandTrades(compressed);

      const buyRouters =
        expanded.map(t => t.buyRouter);

      const sellRouters =
        expanded.map(t => t.sellRouter);

      const amounts =
        expanded.map(t => t.amountIn);

      const buyPaths =
        expanded.map(t => t.bestBuyPath);

      const sellPaths =
        expanded.map(t => t.bestSellPath);

      console.log("\nExecuting flash loan...");
      console.log(
        `Executing ${expanded.length} swaps...\n`
      );

      /* FIX #2 — DYNAMIC GAS */

      const feeData =
        await provider.getFeeData();

      const tx =
        await arb.executeArbitrage(
          buyRouters,
          sellRouters,
          amounts,
          buyPaths,
          sellPaths,
          {
            gasLimit: 15000000,
            gasPrice: feeData.gasPrice
          }
        );

      console.log("TX sent:", tx.hash);

      await tx.wait();

      console.log("Transaction confirmed\n");

    } catch (err) {

      console.log(
        "Batch failed:",
        err.message
      );

    }
  }
}

run();
