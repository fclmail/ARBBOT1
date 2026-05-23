import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE KEY");

/* ================= PROVIDER ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABIs ================= */

const vaultAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
  "function balanceOf(address) view returns(uint256)"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, vaultAbi, wallet);
const usdc = new ethers.Contract(USDC, erc20Abi, wallet);

/* ================= HELPERS ================= */

const fmt = (x, d = 6) =>
  Number(ethers.formatUnits(x, d)).toFixed(6);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================= MOCK BATCH (replace with real builder) ================= */

function buildBatch() {
  return {
    buyRouters: ["0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"],
    sellRouters: ["0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"],
    amountsInUSDC: [ethers.parseUnits("0.02", 6)],
    pathsToToken: [[USDC, "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"]],
    pathsToUSDC: [["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", USDC]],
    deadline: Math.floor(Date.now() / 1000) + 30
  };
}

/* ================= EXECUTION ================= */

async function executeFlashBatch() {
  const start = Date.now();

  const batch = buildBatch();

  /* ================= PRE BALANCES ================= */

  const before = await usdc.balanceOf(CONTRACT_ADDRESS);

  /* ================= SEND TX ================= */

  const tx = await vault.executeFlashBatchArbitrage(batch);

  console.log("====================================================\n");
  console.log("🔥 EXECUTING FLASH BATCH");
  console.log("====================================================\n");

  console.log("🚀 TX HASH:");
  console.log(tx.hash + "\n");

  console.log("⚡ TX STATUS:");
  console.log("SENT\n");

  console.log("⏳ WAITING...\n");

  /* ================= WAIT CONFIRMATION ================= */

  const receipt = await tx.wait();

  /* ================= POST BALANCES ================= */

  const after = await usdc.balanceOf(CONTRACT_ADDRESS);

  const gasUsed = receipt.gasUsed || 0n;

  const profit = after - before;

  const end = Date.now() - start;

  /* ================= FINAL OUTPUT ================= */

  console.log("====================================================\n");
  console.log("🏁 FINAL RESULTS");
  console.log("====================================================\n");

  console.log("💰 REALIZED PROFIT:");
  console.log(`${fmt(profit)} USDC\n`);

  console.log("💰 CONTRACT BEFORE:");
  console.log(`${fmt(before)} USDC\n`);

  console.log("💰 CONTRACT AFTER:");
  console.log(`${fmt(after)} USDC\n`);

  console.log("⛓ GAS USED:");
  console.log(`${gasUsed.toString()}\n`);

  console.log("⚡ SCAN→EXECUTE:");
  console.log(`${end}ms\n`);
}

/* ================= RUN ================= */

(async () => {
  console.log("🚀 FLASH EXECUTOR READY\n");

  while (true) {
    await executeFlashBatch();
    await sleep(1500);
  }
})();
