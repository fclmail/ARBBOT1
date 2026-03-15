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
const TARGET_BATCH_SIZE = 240;
const BUFFER_TARGET = 1000;

const MIN_PROFIT = 0.000001;
const MIN_TRADE = 0.03;

const DEADLINE = 6000;
const SCAN_DELAY = 3000;

/* ================= COLORS ================= */

const green = txt => `\x1b[32m${txt}\x1b[0m`;
const red = txt => `\x1b[31m${txt}\x1b[0m`;
const cyan = txt => `\x1b[36m${txt}\x1b[0m`;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT = "0x6dED2f1A44Ac58201510ddd56677ecb864Af5467";

const abi = [
  "function executeFlashBatchArbitrage(address[],address[],uint256[],address[][],address[][],uint256)",
  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"
];

const vault = new ethers.Contract(VAULT, abi, wallet);

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

/* ================= ROUTERS ================= */

const routers = [
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
];

/* ================= ERC20 ================= */

const erc20 = [
  "function balanceOf(address) view returns(uint)"
];

const usdc = new ethers.Contract(TOKENS.USDC, erc20, provider);

/* ================= BUFFER ================= */

let buffer = [];

/* ================= RANDOM TRADE ================= */

function randomTrade() {

  const buy = routers[Math.floor(Math.random() * routers.length)];
  const sell = routers[Math.floor(Math.random() * routers.length)];

  if (buy === sell) return null;

  const amount =
    MIN_TRADE +
    Math.random() * 0.05;

  const amountIn =
    ethers.parseUnits(
      amount.toFixed(6),
      6
    );

  const profit =
    Math.random() * 0.005;

  if (profit < MIN_PROFIT) return null;

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
    pathB,
    profit
  };

}

/* ================= WORKER ================= */

async function worker(id) {

  while (true) {

    if (buffer.length < BUFFER_TARGET) {

      const t = randomTrade();

      if (t) {

        buffer.push(t);

        console.log(
          green(
            `Worker ${id} profit ${t.profit.toFixed(6)}`
          )
        );

      }

    }

    await new Promise(r => setTimeout(r, 5));

  }

}

/* ================= BALANCES ================= */

async function showBalances() {

  const v = await usdc.balanceOf(VAULT);

  const m = await provider.getBalance(
    wallet.address
  );

  console.log(
    cyan(
      `Vault USDC: ${
        Number(
          ethers.formatUnits(v, 6)
        ).toFixed(3)
      }`
    )
  );

  console.log(
    cyan(
      `MATIC: ${
        Number(
          ethers.formatEther(m)
        ).toFixed(3)
      }`
    )
  );

}

/* ================= EXECUTE ================= */

async function executeBatch() {

  console.log(
    `Collected trades: ${buffer.length}`
  );

  const batch =
    buffer.splice(
      0,
      TARGET_BATCH_SIZE
    );

  console.log(
    `Compressed: ${batch.length}`
  );

  const buy = batch.map(t => t.buy);
  const sell = batch.map(t => t.sell);
  const amt = batch.map(t => t.amountIn);
  const pa = batch.map(t => t.pathA);
  const pb = batch.map(t => t.pathB);

  const deadline =
    Math.floor(Date.now()/1000) +
    DEADLINE;

  console.log("Simulation...");

  try {

    await vault
      .executeFlashBatchArbitrage
      .staticCall(
        buy,
        sell,
        amt,
        pa,
        pb,
        deadline
      );

    console.log(
      green("Simulation passed")
    );

  } catch {

    console.log(
      red("Simulation failed")
    );

    return;

  }

  console.log("Executing batch...");

  const tx =
    await vault
      .executeFlashBatchArbitrage(
        buy,
        sell,
        amt,
        pa,
        pb,
        deadline
      );

  console.log(
    "Transaction sent:",
    tx.hash
  );

  const r = await tx.wait();

  console.log(
    "Transaction confirmed"
  );

  console.log(
    "Gas used:",
    r.gasUsed.toString()
  );

  let ok = 0;
  let fail = 0;
  let profit = 0;

  for (const log of r.logs) {

    try {

      const p =
        vault.interface
          .parseLog(log);

      if (
        p.name ===
        "ArbitrageExecuted"
      ) {

        ok++;

        const pr =
          Number(
            p.args[6]
          ) / 1e6;

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
    green(
      `Total profit: ${profit.toFixed(3)} USDC`
    )
  );

}

/* ================= MAIN ================= */

async function main() {

  console.log(
    "Partial Execution Demo"
  );

  await showBalances();

  for (let i = 0; i < WORKERS; i++)
    worker(i);

  while (true) {

    if (
      buffer.length >=
      BUFFER_TARGET
    ) {

      await executeBatch();

      await showBalances();

    }

    await new Promise(
      r => setTimeout(r, SCAN_DELAY)
    );

  }

}

main();
