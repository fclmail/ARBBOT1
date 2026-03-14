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

if (!RPC_POLYGON) throw new Error("RPC missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PK missing");

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = 0.0003;
const MIN_EXPECTED_PROFIT = 0.000001;
const TARGET_BATCH_SIZE = 30;
const WORKERS = 16;
const DEADLINE_SECONDS = 6000;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(
  WALLET_PRIVATE_KEY,
  provider
);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS =
  "0x6dED2f1A44Ac58201510ddd56677ecb864Af5467";

const vaultAbi = [

  "function executeFlashBatchArbitrage(address[],address[],uint256[],address[][],address[][],uint256)",

  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"

];

const vault =
  new ethers.Contract(
    VAULT_ADDRESS,
    vaultAbi,
    wallet
  );

/* ================= TOKENS ================= */

const TOKENS = {
  USDC:
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC:
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  DAI:
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
};

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap:
    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap:
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
};

/* ================= BUFFER ================= */

let tradeBuffer = [];

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

  console.log(
    `Collected trades: ${tradeBuffer.length}`
  );

  const expanded =
    trades.slice(0, TARGET_BATCH_SIZE);

  console.log(
    `Compressed: ${expanded.length}`
  );

  console.log(
    `Executing batch...\n`
  );

  const buyRouters =
    expanded.map(t => t.buyRouter);

  const sellRouters =
    expanded.map(t => t.sellRouter);

  const amounts =
    expanded.map(t => t.amountIn);

  const pathsA =
    expanded.map(t => t.bestBuyPath);

  const pathsB =
    expanded.map(t => t.bestSellPath);

  const deadline =
    Math.floor(Date.now() / 1000)
    + DEADLINE_SECONDS;

  const tx =
    await vault.executeFlashBatchArbitrage(
      buyRouters,
      sellRouters,
      amounts,
      pathsA,
      pathsB,
      deadline
    );

  console.log(
    "Transaction sent:",
    tx.hash
  );

  const receipt =
    await tx.wait();

  console.log(
    "Transaction confirmed"
  );

  console.log(
    "Gas used:",
    receipt.gasUsed.toString()
  );

  /* ================= EVENT PARSE ================= */

  let executed = 0;
  let failed = 0;
  let totalProfit = 0;

  for (const log of receipt.logs) {

    try {

      const parsed =
        vault.interface.parseLog(log);

      if (
        parsed.name ===
        "ArbitrageExecuted"
      ) {

        executed++;

        const profit =
          Number(
            parsed.args[6]
          ) / 1e6;

        if (profit <= 0)
          failed++;
        else
          totalProfit += profit;

      }

    } catch {}

  }

  console.log(
    `\nSwaps executed: ${executed}`
  );

  console.log(
    `Swaps failed: ${failed}`
  );

  console.log(
    `Total profit: ${totalProfit.toFixed(
      6
    )} USDC`
  );

}

/* ================= DEMO LOOP ================= */

async function main() {

  console.log(
    "MEV Batch Scanner Started"
  );

  while (true) {

    if (
      tradeBuffer.length >=
      TARGET_BATCH_SIZE
    ) {

      const batch =
        tradeBuffer.splice(
          0,
          TARGET_BATCH_SIZE
        );

      await executeBatch(batch);

    }

    await new Promise(r =>
      setTimeout(r, 5000)
    );

  }

}

main();
