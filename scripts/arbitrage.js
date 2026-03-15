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

/* ================= SETTINGS ================= */

const WORKERS = 16;
const BUFFER_TARGET = 1000;
const PARTIAL_SIZE = 120; // safer for simulation
const SCAN_DELAY = 20000;
const DEADLINE_SECONDS = 6000;

/* ================= COLORS ================= */

const green = t => `\x1b[32m${t}\x1b[0m`;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);

const wallet = new ethers.Wallet(
  WALLET_PRIVATE_KEY,
  provider
);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS =
  "0x6dED2f1A44Ac58201510ddd56677ecb864Af5467";

const abi = [
  "function executeFlashBatchArbitrage(address[],address[],uint256[],address[][],address[][],uint256)",
  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"
];

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  abi,
  wallet
);

/* ================= TOKENS ================= */

const TOKENS = {
  USDC:
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC:
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= ROUTERS ================= */

const routers = [
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
];

/* ================= BUFFER ================= */

let buffer = [];

/* ================= RANDOM TRADE ================= */

function makeTrade() {

  const buy =
    routers[Math.floor(Math.random() * routers.length)];

  const sell =
    routers[Math.floor(Math.random() * routers.length)];

  if (buy === sell) return null;

  const amount =
    0.03 + Math.random() * 0.05;

  const amountIn =
    ethers.parseUnits(
      amount.toFixed(6),
      6
    );

  const pathA = [
    TOKENS.USDC,
    TOKENS.WMATIC,
    TOKENS.WETH
  ];

  const pathB = [
    TOKENS.WETH,
    TOKENS.WMATIC,
    TOKENS.USDC
  ];

  return {
    buy,
    sell,
    amountIn,
    pathA,
    pathB
  };
}

/* ================= WORKER ================= */

async function worker() {

  while (true) {

    if (buffer.length < BUFFER_TARGET) {

      const t = makeTrade();

      if (t) {

        buffer.push(t);

        if (
          buffer.length === 900 ||
          buffer.length === 950 ||
          buffer.length === 1000
        ) {
          console.log(
            green(`${buffer.length}/1000`)
          );
        }
      }
    }

    await new Promise(
      r => setTimeout(r, 1)
    );
  }
}

/* ================= PARTIAL FILTER ================= */

function partialFilter() {

  console.log("Filter partial execution...");

  const batch =
    buffer.splice(0, PARTIAL_SIZE);

  console.log(
    "Partial trades kept:",
    batch.length
  );

  return batch;
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

  const buy = trades.map(t => t.buy);
  const sell = trades.map(t => t.sell);
  const amounts = trades.map(t => t.amountIn);
  const pa = trades.map(t => t.pathA);
  const pb = trades.map(t => t.pathB);

  const deadline =
    Math.floor(Date.now() / 1000) +
    DEADLINE_SECONDS;

  console.log("Simulation start...");

  try {

    await vault
      .executeFlashBatchArbitrage
      .staticCall(
        buy,
        sell,
        amounts,
        pa,
        pb,
        deadline
      );

    console.log(
      green("Simulation pass")
    );

  } catch {

    console.log("Simulation failed");
    return;
  }

  console.log("");
  console.log("Collected trades: 1000");
  console.log("Compressed: 120");
  console.log("Executing batch...");

  const tx =
    await vault.executeFlashBatchArbitrage(
      buy,
      sell,
      amounts,
      pa,
      pb,
      deadline
    );

  const receipt = await tx.wait();

  let ok = 0;
  let fail = 0;
  let profit = 0;

  for (const log of receipt.logs) {

    try {

      const p =
        vault.interface.parseLog(log);

      if (p.name === "ArbitrageExecuted") {

        ok++;

        const pr =
          Number(p.args[6]) / 1e6;

        if (pr <= 0)
          fail++;
        else
          profit += pr;
      }

    } catch {}
  }

  console.log(
    `Swaps executed: ${ok}`
  );

  console.log(
    `Swaps failed: ${fail}`
  );

  console.log(
    `Total profit: ${profit.toFixed(3)} USDC`
  );

  console.log("");

  console.log(
    "Transaction sent:",
    tx.hash
  );

  console.log(
    "Transaction confirmed"
  );

  console.log(
    "Gas used:",
    receipt.gasUsed.toString()
  );
}

/* ================= MAIN ================= */

async function main() {

  console.log("Elo");

  for (let i = 0; i < WORKERS; i++)
    worker();

  while (true) {

    if (buffer.length >= BUFFER_TARGET) {

      const batch =
        partialFilter();

      await executeBatch(batch);
    }

    await new Promise(
      r => setTimeout(r, SCAN_DELAY)
    );
  }
}

main();
