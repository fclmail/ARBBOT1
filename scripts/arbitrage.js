// scripts/arbitrage.js
// =======================================================
// Arbitrage bot — error-safe version
// FIX: prevents "invalid value for Contract target"
// =======================================================

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ================= CONFIG =================
const DRY_RUN = process.env.DRY_RUN === "true";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

// 🔧 FIX #1 — SAFE VAULT ADDRESS HANDLING
const VAULT_ADDRESS =
  process.env.VAULT_CONTRACT ||
  "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// 🔒 HARD FAIL IF STILL INVALID
if (!ethers.isAddress(VAULT_ADDRESS)) {
  throw new Error("❌ VAULT_CONTRACT is missing or invalid");
}

if (!DRY_RUN && !PRIVATE_KEY) {
  throw new Error("❌ PRIVATE_KEY required for live mode");
}

// ================= PROVIDER / WALLET =================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ================= ROUTERS =================
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

// ================= TOKENS =================
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

// ================= ABIs =================
const arbAbi = [
  {
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint256" },
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [], name: "USDC", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
];

// ================= CONTRACTS =================
// 🔧 FIX #2 — CONTRACT CREATED ONLY AFTER VALIDATION
const arbContract = new ethers.Contract(
  VAULT_ADDRESS,
  arbAbi,
  DRY_RUN ? provider : wallet
);

let usdcAddress;
let usdcContract;

// ================= INIT =================
async function init() {
  usdcAddress = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddress, erc20Abi, provider);

  console.log("🏛 Vault Address:", VAULT_ADDRESS);
  console.log("💵 USDC Address :", usdcAddress);
  console.log(DRY_RUN ? "🔬 DRY RUN MODE" : "🚀 LIVE MODE");
}

// ================= HELPERS =================
function fmt(n, d = 6) {
  return Number(n).toFixed(d);
}

async function getAmountOut(routerAddr, amountIn, path) {
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  const out = await router.getAmountsOut(amountIn, path);
  return out[out.length - 1];
}

// ================= CORE LOGIC (UNCHANGED) =================
// ⬇️ Everything below is intentionally left intact ⬇️
// (scanning, profit checks, execution, CSV, etc.)

// … your existing scanAllPairs(), executeTradeLive(), CSV logic, etc.
// NO changes required for this error

// ================= MAIN =================
(async () => {
  await init();

  setInterval(async () => {
    try {
      await scanAllPairs(); // existing function
    } catch (e) {
      console.error("Scanner error:", e.message);
    }
  }, 10_000);
})();
