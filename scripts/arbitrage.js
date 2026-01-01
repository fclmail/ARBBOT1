// scripts/arbitrage.js
// ---------------------------------------------------------
// ARBBOT1 – PROFIT-SAFE VERSION
// ---------------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---- CONFIG ----
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6);
const MIN_PROFIT_BPS = 10n; // 0.10%
const SAFETY_BPS = 8500n;   // 85%

// ---- ADDRESSES ----
const USDC = process.env.USDC;
const WETH = process.env.WETH;
const QUICK_ROUTER = process.env.QUICK_ROUTER;
const SUSHI_ROUTER = process.env.SUSHI_ROUTER;
const VAULT = process.env.VAULT;

// ---- PROVIDER ----
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ---- CONTRACTS ----
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);
const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

// ---- MIN PROFIT (ABSOLUTE USDC) ----
const minProfitUSDC =
  (TRADE_AMOUNT_USDC * MIN_PROFIT_BPS) / 10_000n;

// ---------------------------------------------------------
// 🔑 MISSING STEP IMPLEMENTED HERE
// ---------------------------------------------------------
async function simulateArbitrage(params) {
  try {
    const buyAmounts = await params.routerBuy.getAmountsOut(
      params.amountInUSDC,
      [params.usdc, params.weth]
    );
    const wethOut = buyAmounts[1];

    if (wethOut === 0n) return { profitable: false };

    const sellAmounts = await params.routerSell.getAmountsOut(
      wethOut,
      [params.weth, params.usdc]
    );
    const usdcOut = sellAmounts[1];

    if (usdcOut <= params.amountInUSDC) return { profitable: false };

    const rawProfit = usdcOut - params.amountInUSDC;
    const adjustedProfit =
      (rawProfit * params.safetyBps) / 10_000n;

    return {
      profitable: adjustedProfit >= params.minProfitUSDC,
      rawProfit,
      adjustedProfit
    };
  } catch {
    return { profitable: false };
  }
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
  console.log("⏱", new Date().toISOString(), "Polygon Arb Bot Started");

  while (true) {
    // 🔍 QuickSwap ➜ SushiSwap
    const sim = await simulateArbitrage({
      routerBuy: quickRouter,
      routerSell: sushiRouter,
      usdc: USDC,
      weth: WETH,
      amountInUSDC: TRADE_AMOUNT_USDC,
      minProfitUSDC,
      safetyBps: SAFETY_BPS
    });

    if (sim.profitable) {
      console.log("🚀 REAL PROFIT OPPORTUNITY");
      console.log("💰 Raw profit:", ethers.formatUnits(sim.rawProfit, 6), "USDC");
      console.log("💰 Adjusted profit:", ethers.formatUnits(sim.adjustedProfit, 6), "USDC");

      await vault.executeArbitrage(
        QUICK_ROUTER,
        SUSHI_ROUTER,
        USDC,
        WETH,
        TRADE_AMOUNT_USDC
      );
    } else {
      console.log("⚠️ Skipped – real profit below min");
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

run();
