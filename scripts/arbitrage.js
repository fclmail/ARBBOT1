// 🟢1 FILE PURPOSE
// scripts/arbitrage.js
// Polygon DEX arbitrage scanner + executor with vault safety

import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

/* ================= CONFIG ================= */

// 🟢3 RPC
const RPC_POLYGON =
  (
    process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    ""
  ).trim();

// 🟢4 PRIVATE KEY
const WALLET_PRIVATE_KEY =
  (
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    ""
  ).trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE KEY missing");

/* ================= CONSTANTS ================= */

// 🟢7 TRADE LOGIC (UNCHANGED)
const MIN_TRADE_USDC = 0.03;
const MIN_EXPECTED_PROFIT = 0.000001;
const DEADLINE_SECONDS = 60;

// ⏱ HARD SCAN INTERVAL
const SCAN_INTERVAL_MS = 10_000;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT ================= */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  {
    name: "executeArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  },
  {
    name: "usdc",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }]
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null; // liquidity / pool missing fallback
  }
}

/* ================= CORE ARB ================= */

async function tryArb(buyName, buyRouter, sellName, sellRouter, tokenName, tokenAddr) {

  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyPath = [usdc, tokenAddr];
  const sellPath = [tokenAddr, usdc];

  console.log(
    `🔎 SCAN | ${tokenName} | BUY ${buyName} → SELL ${sellName}`
  );

  const buyOut = await quote(buyRouter, amountIn, buyPath);
  if (!buyOut) return;

  const sellOut = await quote(sellRouter, buyOut, sellPath);
  if (!sellOut) return;

  const received = Number(ethers.formatUnits(sellOut, 6));
  const profit = received - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log(
    `🔥 ARB FOUND | ${tokenName} | ${buyName} → ${sellName} | PROFIT ${profit.toFixed(6)} USDC`
  );

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    amountIn,
    buyPath,
    sellPath,
    deadline
  );

  console.log(`⛓ TX SENT: ${tx.hash}`);

  // NON-BLOCKING CONFIRMATION
  tx.wait().then(() => {
    console.log(`✅ CONFIRMED | VAULT DEPOSITED | ${tx.hash}`);
  }).catch(() => {});
}

/* ================= SCANNER ================= */

async function scan() {
  console.log(`\n🔍 NEW SCAN @ ${new Date().toISOString()}`);

  for (const [tokenName, tokenAddr] of Object.entries(TOKENS)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyRouter === sellRouter) continue;

        try {
          await tryArb(
            buyName,
            buyRouter,
            sellName,
            sellRouter,
            tokenName,
            tokenAddr
          );
          await sleep(100); // light RPC throttle
        } catch (e) {
          console.log(`⚠️ ${e.message}`);
        }
      }
    }
  }
}

/* ================= MAIN ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
