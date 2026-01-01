// scripts/arbitrage.js
// ---------------------------------------------------------
// ARBBOT1 – PROFIT-SAFE VERSION (FULL FILE)
// ---------------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6); // 1,000 USDC
const MIN_PROFIT_BPS = 10n; // 0.10%
const SAFETY_BPS = 8500n;   // 85%
const LOOP_DELAY_MS = 2000;

// ---------------------------------------------------------
// ABIs
// ---------------------------------------------------------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory)"
];

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address tokenIn, address tokenOut, uint256 amountIn) external"
];

// ---------------------------------------------------------
// ADDRESSES (ENV)
// ---------------------------------------------------------
const {
  RPC_URL,
  PRIVATE_KEY,
  USDC,
  WETH,
  QUICK_ROUTER,
  SUSHI_ROUTER,
  VAULT
} = process.env;

// ---------------------------------------------------------
// PROVIDER / WALLET
// ---------------------------------------------------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------------------------------------------------
// CONTRACTS
// ---------------------------------------------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);
const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

// ---------------------------------------------------------
// MIN PROFIT (ABSOLUTE USDC)
// ---------------------------------------------------------
const minProfitUSDC =
  (TRADE_AMOUNT_USDC * MIN_PROFIT_BPS) / 10_000n;

// ---------------------------------------------------------
// 🔑 MISSING STEP — FULL PATH SIMULATION
// ---------------------------------------------------------
async function simulateArbitrage({
  routerBuy,
  routerSell,
  amountInUSDC
}) {
  try {
    // 1️⃣ USDC -> WETH (buy)
    const buyAmounts = await routerBuy.getAmountsOut(
      amountInUSDC,
      [USDC, WETH]
    );
    const wethOut = buyAmounts[1];

    if (wethOut === 0n) return null;

    // 2️⃣ WETH -> USDC (sell)
    const sellAmounts = await routerSell.getAmountsOut(
      wethOut,
      [WETH, USDC]
    );
    const usdcOut = sellAmounts[1];

    if (usdcOut <= amountInUSDC) return null;

    // 3️⃣ Profit math
    const rawProfit = usdcOut - amountInUSDC;
    const adjustedProfit =
      (rawProfit * SAFETY_BPS) / 10_000n;

    return {
      wethOut,
      usdcOut,
      rawProfit,
      adjustedProfit
    };
  } catch (err) {
    console.error("Simulation error:", err.message);
    return null;
  }
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
  console.log("⏱", new Date().toISOString(), "Polygon Arb Bot Started");

  while (true) {
    try {
      // ---------------------------------------------------
      // 🔍 QuickSwap ➜ SushiSwap
      // ---------------------------------------------------
      console.log("🔍 QuickSwap ➜ SushiSwap");

      const sim = await simulateArbitrage({
        routerBuy: quickRouter,
        routerSell: sushiRouter,
        amountInUSDC: TRADE_AMOUNT_USDC
      });

      if (!sim) {
        console.log("⚠️ No real profit after fees – skipping\n");
      } else {
        console.log(
          "💰 Raw profit:",
          ethers.formatUnits(sim.rawProfit, 6),
          "USDC"
        );
        console.log(
          "💰 Adjusted profit:",
          ethers.formatUnits(sim.adjustedProfit, 6),
          "USDC"
        );

        if (sim.adjustedProfit >= minProfitUSDC) {
          console.log("🚀 REAL PROFIT OPPORTUNITY");
          console.log("📤 Sending tx to vault...");

          const tx = await vault.executeArbitrage(
            QUICK_ROUTER,
            SUSHI_ROUTER,
            USDC,
            WETH,
            TRADE_AMOUNT_USDC
          );

          console.log("⏳ Tx hash:", tx.hash);
          await tx.wait();
          console.log("✅ Arbitrage completed\n");
        } else {
          console.log("⚠️ Below vault min profit – skipping\n");
        }
      }
    } catch (err) {
      console.error("Loop error:", err.message);
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

run();
