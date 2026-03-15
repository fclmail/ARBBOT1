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
const BUFFER_TARGET = 3; // execute batch when full
const SCAN_DELAY = 20000;   // 1 scan per 20s
const DEADLINE_SECONDS = 6000;

/* ================= COLORS ================= */
const green = t => `\x1b[32m${t}\x1b[0m`;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS =
  "0x6dED2f1A44Ac58201510ddd56677ecb864Af5467";

const vaultAbi = [
  "function executeFlashBatchArbitrage(address[],address[],uint256[],address[][],address[][],uint256)",
  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= ROUTERS ================= */
const routers = [
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
];

/* ================= BUFFER ================= */
let buffer = [];

/* ================= RANDOM TRADE GENERATOR ================= */
function makeTrade() {
  const buy = routers[Math.floor(Math.random() * routers.length)];
  const sell = routers[Math.floor(Math.random() * routers.length)];
  if (buy === sell) return null;

  const amount = 0.01 + Math.random() * 0.02; // safe small amounts
  const amountIn = ethers.parseUnits(amount.toFixed(6), 6);

  const pathA = [TOKENS.USDC, TOKENS.WMATIC];
  const pathB = [TOKENS.WMATIC, TOKENS.USDC];

  return { buy, sell, amountIn, pathA, pathB };
}

/* ================= WORKERS ================= */
async function worker() {
  while (true) {
    if (buffer.length < BUFFER_TARGET) {
      const t = makeTrade();
      if (t) {
        buffer.push(t);
        if (
          buffer.length === 1 ||
          buffer.length === 250 ||
          buffer.length === 500 ||
          buffer.length === 750 ||
          buffer.length === 900 ||
          buffer.length === 950 ||
          buffer.length === 1000
        ) {
          console.log(green(`${buffer.length}/1000`));
        }
      }
    }
    await new Promise(r => setTimeout(r, 1)); // worker fast
  }
}

/* ================= EXECUTE BATCH ================= */
async function executeBatch(trades) {
  const buy = trades.map(t => t.buy);
  const sell = trades.map(t => t.sell);
  const amounts = trades.map(t => t.amountIn);
  const pa = trades.map(t => t.pathA);
  const pb = trades.map(t => t.pathB);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log("\nSimulation start...");
  try {
    await vault.executeFlashBatchArbitrage.staticCall(
      buy,
      sell,
      amounts,
      pa,
      pb,
      deadline
    );
    console.log(green("Simulation pass"));
  } catch (err) {
    console.log("Simulation failed:", err.message || "");
    return;
  }

  console.log("Executing batch...\n");

  const tx = await vault.executeFlashBatchArbitrage(
    buy,
    sell,
    amounts,
    pa,
    pb,
    deadline
  );

  const receipt = await tx.wait();

  let totalExecuted = 0;
  let totalFailed = 0;
  let totalProfit = 0;
  let totalGas = receipt.gasUsed;

  for (const log of receipt.logs) {
    try {
      const parsed = vault.interface.parseLog(log);
      if (parsed.name === "ArbitrageExecuted") {
        totalExecuted++;
        const profit = Number(parsed.args[6]) / 1e6;
        if (profit <= 0) totalFailed++;
        else totalProfit += profit;
      }
    } catch {}
  }

  console.log(`Swaps executed: ${totalExecuted}`);
  console.log(`Swaps failed: ${totalFailed}`);
  console.log(`Total profit: ${totalProfit.toFixed(6)} USDC`);
  console.log(`Total gas used: ${totalGas.toString()}`);
  console.log("Transaction sent:", tx.hash);
  console.log("Transaction confirmed\n");
}

/* ================= MAIN ================= */
async function main() {
  console.log("Elo");

  for (let i = 0; i < WORKERS; i++) worker();

  while (true) {
    if (buffer.length >= BUFFER_TARGET) {
      console.log("\nBuffer full. Executing contract batch loop...");
      await executeBatch(buffer);
      buffer = []; // clear buffer after execution
    }
    await new Promise(r => setTimeout(r, SCAN_DELAY));
  }
}

main();
