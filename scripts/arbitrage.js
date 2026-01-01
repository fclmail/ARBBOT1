// scripts/arbitrage.js
// ---------------------------------------------------------
// ARBBOT1 – HARD-CODED ADDRESS FIX (POLYGON)
// ---------------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------
// RPC / WALLET (still from env — SAFE)
// ---------------------------------------------------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------------------------------------------------
// 🔒 HARDCODED POLYGON ADDRESSES (FIX)
// ---------------------------------------------------------
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH  = "0x172370d5cd63279efa6d502dab29171933a610af";

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const VAULT = "0x7DadE334120e659eDE4999c8813c183648b1bd19"; // 👈 MUST be valid

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6);
const MIN_PROFIT_BPS = 10n;     // 0.10%
const SAFETY_BPS = 8500n;       // 85%
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
// CONTRACTS (NOW SAFE)
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
// 🔑 FULL-PATH ARBITRAGE SIMULATION (UNCHANGED)
// ---------------------------------------------------------
async function simulateArbitrage({
  routerBuy,
  routerSell,
  amountInUSDC
}) {
  try {
    const buyAmounts = await routerBuy.getAmountsOut(
      amountInUSDC,
      [USDC, WETH]
    );
    const wethOut = buyAmounts[1];
    if (wethOut === 0n) return null;

    const sellAmounts = await routerSell.getAmountsOut(
      wethOut,
      [WETH, USDC]
    );
    const usdcOut = sellAmounts[1];
    if (usdcOut <= amountInUSDC) return null;

    const rawProfit = usdcOut - amountInUSDC;
    const adjustedProfit =
      (rawProfit * SAFETY_BPS) / 10_000n;

    return { wethOut, usdcOut, rawProfit, adjustedProfit };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
  console.log("⏱", new Date().toISOString(), "Polygon Arb Bot Started");

  while (true) {
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

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

run();
