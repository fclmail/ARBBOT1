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

/* ================= CONTRACT ================= */

const CONTRACT =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const ABI = [
 "function executeFlashBatchArbitrage((address[],address[],uint256[],address[][],address[][],uint256)) external"
];

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.01", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.002", 6);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let isExecuting = false;

let arb;

/* ================= PROVIDER ================= */

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

/* ================= UTILS ================= */

const fmt = x => ethers.formatUnits(x, 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= INIT ================= */

async function init() {
  provider = newProvider();
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  arb = new ethers.Contract(
    CONTRACT,
    ABI,
    wallet
  );

  console.log("🚀 CONTRACT ARB BOT STARTED\n");
}

/* ================= ROUTER ABI ================= */

const routerABI = [
"function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"
];

/* ================= QUOTE ================= */

async function getQuote(router, path, amount) {
  try {

    const r = new ethers.Contract(
      router,
      routerABI,
      provider
    );

    const amounts =
      await r.getAmountsOut(amount, path);

    return amounts[amounts.length - 1];

  } catch {
    return 0n;
  }
}

/* ================= FIND TRADE ================= */

async function findTrade() {

  const tokens = [
    TOKENS.WMATIC,
    TOKENS.WETH,
    TOKENS.DAI
  ];

  for (const buyName in routers) {
    for (const sellName in routers) {

      if (buyName === sellName) continue;

      const buyRouter = routers[buyName];
      const sellRouter = routers[sellName];

      for (const token of tokens) {

        const pathToToken = [
          TOKENS.USDC,
          token
        ];

        const pathToUSDC = [
          token,
          TOKENS.USDC
        ];

        const tokenOut =
          await getQuote(
            buyRouter,
            pathToToken,
            TRADE_AMOUNT
          );

        if (tokenOut === 0n) continue;

        const usdcBack =
          await getQuote(
            sellRouter,
            pathToUSDC,
            tokenOut
          );

        if (usdcBack === 0n) continue;

        if (usdcBack > TRADE_AMOUNT) {

          const profit =
            usdcBack - TRADE_AMOUNT;

          return {
            buyRouter,
            sellRouter,
            amountIn: TRADE_AMOUNT,
            expectedProfit: profit,
            pathToToken,
            pathToUSDC
          };
        }
      }
    }
  }

  return null;
}

/* ================= EXECUTE BATCH ================= */

async function executeBatch(batch) {

  try {

    console.log("\n🚀 EXECUTING BATCH");
    console.log(`📦 SIZE ${batch.length}`);

    const buyRouters = batch.map(t => t.buyRouter);
    const sellRouters = batch.map(t => t.sellRouter);
    const amountsInUSDC = batch.map(t => t.amountIn);
    const pathsToToken = batch.map(t => t.pathToToken);
    const pathsToUSDC = batch.map(t => t.pathToUSDC);

    const deadline =
      Math.floor(Date.now()/1000) + 60;

    const tx =
      await arb.executeFlashBatchArbitrage({
        buyRouters,
        sellRouters,
        amountsInUSDC,
        pathsToToken,
        pathsToUSDC,
        deadline
      });

    console.log(`TX SENT ${tx.hash}`);
    console.log("WAITING CONFIRMATION...\n");

    await tx.wait();

    console.log("✅ BATCH EXECUTED\n");

  } catch (e) {

    console.log("⚠️ EXECUTION FAILED");
    console.log(e.message);

  } finally {

    isExecuting = false;
    microTrades = [];
    runningProfit = 0n;

  }
}

/* ================= MAIN LOOP ================= */

async function scanLoop() {

  while (true) {

    if (isExecuting) {
      await sleep(10);
      continue;
    }

    const trade = await findTrade();

    if (!trade) continue;

    microTrades.push(trade);
    runningProfit += trade.expectedProfit;

    console.log(
      `ADD TRADE +${fmt(trade.expectedProfit)}`
    );

    console.log(
      `RUNNING ${fmt(runningProfit)} | ${microTrades.length}`
    );

    if (
      runningProfit >= MIN_BATCH_PROFIT &&
      !isExecuting
    ) {

      console.log(
        "\n🎯 BATCH PROFIT HIT\n"
      );

      const batch = [...microTrades];

      isExecuting = true;

      executeBatch(batch);
    }
  }
}

/* ================= START ================= */

(async function main() {
  await init();
  await scanLoop();
})();
