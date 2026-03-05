// 🟢1 FILE PURPOSE
// scripts/arbitrage.js
// This script scans DEX prices on Polygon and executes arbitrage
// trades through a deployed Vault smart contract.

import dotenv from "dotenv";
import { ethers } from "ethers";

/**
 * 🟢2 ENVIRONMENT HANDLING
 */
dotenv.config({ override: false });

/* ================= CONFIG ================= */

// 🟢3 RPC URL SELECTION
const RPC_RAW =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

// 🟢4 PRIVATE KEY SELECTION
const PRIVATE_KEY_RAW =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

// 🟢5 NORMALIZATION
const RPC_POLYGON = RPC_RAW.trim();
const WALLET_PRIVATE_KEY = PRIVATE_KEY_RAW.trim();

// 🟢6 STRICT VALIDATION
if (!RPC_POLYGON) throw new Error("RPC_POLYGON is missing or empty");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is missing or empty");

/* ================= CONSTANTS ================= */

// 🟢7 TRADE SETTINGS (UNCHANGED)
const MIN_TRADE_USDC = .02;
const MIN_EXPECTED_PROFIT = 0.000001;
const SLIPPAGE_PCT = 0.05;
const SCAN_INTERVAL_MS = 10_000; // ✅ HARD 10 SECOND SCAN
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

// 🟢8 BLOCKCHAIN CONNECTION
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);

// 🟢9 WALLET INSTANCE
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

// 🟢10 VAULT CONTRACT ADDRESS
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

// 🟢11 VAULT ABI
const vaultAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "uint256", name: "amountInUSDC", type: "uint256" },
      { internalType: "address[]", name: "pathToToken", type: "address[]" },
      { internalType: "address[]", name: "pathToUSDC", type: "address[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

// 🟢12 VAULT CONTRACT INSTANCE
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

// 🟢13 DEX ROUTERS
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// 🟢14 ROUTER ABI
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

// 🟢15 TOKENS
const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

// 🟢16 WMATIC (unused but kept)
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

/* ================= HELPERS ================= */

// 🟢17 SLEEP HELPER (KEPT, SHORT)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🟢18 PRICE QUOTE FUNCTION
async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/* ================= CORE LOGIC ================= */

// 🟢19 ARBITRAGE ATTEMPT FUNCTION
async function tryArb(buyRouter, sellRouter, tokenAddr) {

  // 🟢20 FETCH USDC
  const usdc = await vault.usdc();

  // 🟢21 TRADE SIZE
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  // 🟢22 PATHS
  const directPathBuy = [usdc, tokenAddr];
  const directPathSell = [tokenAddr, usdc];

  // 🟢23 BUY QUOTE
  const buyOut = await quote(buyRouter, amountIn, directPathBuy);
  if (!buyOut) return;

  // 🟢24 SELL QUOTE
  const sellOut = await quote(sellRouter, buyOut, directPathSell);
  if (!sellOut) return;

  // 🟢25 PROFIT CALC
  const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));
  const profit = receivedUSDC - MIN_TRADE_USDC;

  // 🟢26 PROFIT FILTER (UNCHANGED)
  if (profit < MIN_EXPECTED_PROFIT) return;

  // 🟢27 DEADLINE
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log(`🔥 ARB FOUND | Profit ≈ ${profit.toFixed(6)} USDC`);

  // 🟢28 EXECUTE ARB
  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    amountIn,
    directPathBuy,
    directPathSell,
    deadline
  );

  console.log(`⛓ TX SENT: ${tx.hash}`);

  // 🟢29 NON-BLOCKING CONFIRMATION (FIX)
  tx.wait().then(() => {
    console.log(`✅ CONFIRMED & DEPOSITED | ${tx.hash}`);
  }).catch(() => {});
}

/* ================= SCANNER ================= */

// 🟢30 FULL MARKET SCAN
async function scan() {
  console.log(`🔍 Scan started @ ${new Date().toISOString()}`);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        try {
          await tryArb(buy, sell, token);
          await sleep(100); // ✅ light throttle
        } catch (e) {
          console.log(`⚠️ ${e.message}`);
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

// 🟢31 BOT ENTRY POINT
console.log("🚀 Arbitrage bot started");

// 🟢32 TIME-BASED SCANNER (FIX)
setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
