#!/usr/bin/env node
// ==========================================================
// Bidirectional Arbitrage Scanner (Ethers v6)
// - Safe BigInt arithmetic
// - Auto decimal normalization
// - Works both locally (.env) and in GitHub Actions
// ==========================================================

import { ethers } from "ethers";

// ✅ Optional dotenv import (only loads locally)
try {
  const dotenv = await import("dotenv");
  dotenv.config();
  console.log("ℹ️ Loaded .env configuration (local mode).");
} catch {
  console.log("ℹ️ dotenv not found — skipping (GitHub Actions mode).");
}

// ==========================================================
// 1️⃣ Environment variables
// ==========================================================
const {
  RPC_A,
  RPC_B,
  PRIVATE_KEY,
  ROUTER_A,
  ROUTER_B,
  USDC_ADDRESS,
  TOKEN_ADDRESS,
  AMOUNT_USDC,
  MIN_PROFIT_USDC,
} = process.env;

// ==========================================================
// 2️⃣ Basic validation
// ==========================================================
if (!RPC_A || !RPC_B || !ROUTER_A || !ROUTER_B || !USDC_ADDRESS || !TOKEN_ADDRESS) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

const providerA = new ethers.JsonRpcProvider(RPC_A);
const providerB = new ethers.JsonRpcProvider(RPC_B);

const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, providerA) : null;

// Minimal ABIs
const ERC20_ABI = ["function decimals() view returns (uint8)"];
const ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, providerA);
const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, providerA);
const routerA = new ethers.Contract(ROUTER_A, ROUTER_ABI, providerA);
const routerB = new ethers.Contract(ROUTER_B, ROUTER_ABI, providerB);

let USDC_DECIMALS = 6;
let TOKEN_DECIMALS = 18;
let amountInUSDCBase;
let MIN_PROFIT_UNITS;

// ==========================================================
// 3️⃣ Initialize token decimals and normalize constants
// ==========================================================
async function initDecimals() {
  try {
    USDC_DECIMALS = Number(await usdc.decimals());
    TOKEN_DECIMALS = Number(await token.decimals());

    const amountInStr = (AMOUNT_USDC || "10").toString();
    const minProfitStr = (MIN_PROFIT_USDC || "0.000001").toString();

    // Avoid exponential formats and enforce USDC_DECIMALS precision
    const safeAmountStr = Number(amountInStr).toFixed(USDC_DECIMALS);
    const safeMinProfitStr = Number(minProfitStr).toFixed(USDC_DECIMALS);

    amountInUSDCBase = ethers.parseUnits(safeAmountStr, USDC_DECIMALS);
    MIN_PROFIT_UNITS = ethers.parseUnits(safeMinProfitStr, USDC_DECIMALS);

    console.log(`🔧 Decimals initialized: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
    console.log(`🔧 amountInUSDCBase=${amountInUSDCBase.toString()}`);
    console.log(`🔧 MIN_PROFIT_UNITS=${MIN_PROFIT_UNITS.toString()}`);
  } catch (err) {
    console.error("❌ Failed to initialize decimals:", err);
    process.exit(1);
  }
}

// ==========================================================
// 4️⃣ Helpers
// ==========================================================
async function getQuote(router, fromToken, toToken, amountIn, label) {
  try {
    const amounts = await router.getAmountsOut(amountIn, [fromToken, toToken]);
    return amounts[1];
  } catch (err) {
    console.error(`⚠️ Quote error on ${label}:`, err.message);
    return 0n;
  }
}

function toHuman(baseValue, decimals) {
  const sign = baseValue < 0n ? "-" : "";
  const abs = baseValue < 0n ? -baseValue : baseValue;
  return `${sign}${ethers.formatUnits(abs, decimals)}`;
}

// ==========================================================
// 5️⃣ Main scanning loop
// ==========================================================
async function runLoop() {
  console.log("🚀 Starting bidirectional live arbitrage scanner\n");

  providerA.on("block", async (blockNumber) => {
    console.log(`[#${blockNumber}] 🔍 Scanning both directions...`);

    // 🔹 Direction A→B
    const buyOutA = await getQuote(routerA, USDC_ADDRESS, TOKEN_ADDRESS, amountInUSDCBase, "A→B-buy");
    const sellOutB = await getQuote(routerB, TOKEN_ADDRESS, USDC_ADDRESS, buyOutA, "A→B-sell");
    const profitA = sellOutB - amountInUSDCBase;

    console.log(`[A→B] 💱 Buy → ${ethers.formatUnits(buyOutA, TOKEN_DECIMALS)} TOKEN`);
    console.log(`[A→B] 💲 Sell → ${ethers.formatUnits(sellOutB, USDC_DECIMALS)} USDC`);
    console.log(`[A→B] 🧮 Profit = ${toHuman(profitA, USDC_DECIMALS)} USDC`);

    if (profitA >= MIN_PROFIT_UNITS) {
      console.log(`[A→B] ✅ Profitable! Executing trade...`);
      // if (wallet) await executeArbitrage("A→B", amountInUSDCBase);
    } else {
      console.log(`[A→B] 🚫 Not profitable (below threshold).`);
    }

    // 🔹 Direction B→A
    const buyOutB = await getQuote(routerB, USDC_ADDRESS, TOKEN_ADDRESS, amountInUSDCBase, "B→A-buy");
    const sellOutA = await getQuote(routerA, TOKEN_ADDRESS, USDC_ADDRESS, buyOutB, "B→A-sell");
    const profitB = sellOutA - amountInUSDCBase;

    console.log(`[B→A] 💱 Buy → ${ethers.formatUnits(buyOutB, TOKEN_DECIMALS)} TOKEN`);
    console.log(`[B→A] 💲 Sell → ${ethers.formatUnits(sellOutA, USDC_DECIMALS)} USDC`);
    console.log(`[B→A] 🧮 Profit = ${toHuman(profitB, USDC_DECIMALS)} USDC`);

    if (profitB >= MIN_PROFIT_UNITS) {
      console.log(`[B→A] ✅ Profitable! Executing trade...`);
      // if (wallet) await executeArbitrage("B→A", amountInUSDCBase);
    } else {
      console.log(`[B→A] 🚫 Not profitable (below threshold).`);
    }
  });
}

// ==========================================================
// 6️⃣ Run
// ==========================================================
(async function main() {
  try {
    await initDecimals();
    await runLoop();
  } catch (err) {
    console.error("❌ Fatal error in main loop:", err);
    process.exit(1);
  }
})();

   
