// scripts/arbitrage.js
// ---------------------------------------------------------
// ARBBOT1 – PRICE RATIO MULTI-OPPORTUNITY ARBITRAGE
// Polygon Mainnet
// ---------------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------
// PROVIDER / WALLET
// ---------------------------------------------------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ---------------------------------------------------------
// TOKEN ADDRESSES (POLYGON)
// ---------------------------------------------------------
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// ---------------------------------------------------------
// DEX ROUTERS
// ---------------------------------------------------------
const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// ---------------------------------------------------------
// VAULT (HARDCODED – NO ENS)
// ---------------------------------------------------------
const VAULT = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6);
const MIN_PROFIT_USDC   = ethers.parseUnits("0.01", 6);
const SAFETY_BPS        = 8500n; // 85%
const LOOP_DELAY_MS     = 2000;

// ---------------------------------------------------------
// ABIs
// ---------------------------------------------------------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external returns (uint[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)"
];

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address tokenIn,address tokenOut,uint256 amountIn) external"
];

// ---------------------------------------------------------
// CONTRACTS
// ---------------------------------------------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);
const usdc        = new ethers.Contract(USDC, ERC20_ABI, provider);
const vault       = new ethers.Contract(VAULT, VAULT_ABI, wallet);

// ---------------------------------------------------------
// PRICE-RATIO SCAN (INDEPENDENT ROUTER CALLS)
// ---------------------------------------------------------
async function scanOpportunity(buyRouter, sellRouter, buyName, sellName) {
  const buyAmounts = await buyRouter.getAmountsOut(
    TRADE_AMOUNT_USDC,
    [USDC, WETH]
  );

  const wethBought = buyAmounts[1];
  if (wethBought === 0n) return null;

  const sellAmounts = await sellRouter.getAmountsOut(
    wethBought,
    [WETH, USDC]
  );

  const usdcReceived = sellAmounts[1];
  if (usdcReceived <= TRADE_AMOUNT_USDC) return null;

  const buyPrice  = Number(TRADE_AMOUNT_USDC) / Number(wethBought);
  const sellPrice = Number(usdcReceived) / Number(wethBought);

  const priceDiff    = sellPrice - buyPrice;
  const ratioPercent = (priceDiff / buyPrice) * 100;

  const grossProfit    = usdcReceived - TRADE_AMOUNT_USDC;
  const adjustedProfit = (grossProfit * SAFETY_BPS) / 10_000n;

  return {
    buyRouter,
    sellRouter,
    buyName,
    sellName,
    buyPrice,
    sellPrice,
    ratioPercent,
    grossProfit,
    adjustedProfit
  };
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
  console.log("⏱", new Date().toISOString(), "Polygon Arb Bot Started");

  while (true) {
    const opportunities = [];

    const qToS = await scanOpportunity(
      quickRouter,
      sushiRouter,
      "QuickSwap",
      "SushiSwap"
    );
    if (qToS) opportunities.push(qToS);

    const sToQ = await scanOpportunity(
      sushiRouter,
      quickRouter,
      "SushiSwap",
      "QuickSwap"
    );
    if (sToQ) opportunities.push(sToQ);

    if (opportunities.length === 0) {
      console.log("⚠️ No price-ratio opportunity\n");
      await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
      continue;
    }

    opportunities.sort(
      (a, b) => Number(b.adjustedProfit - a.adjustedProfit)
    );

    const best = opportunities[0];

    console.log(`🔍 ${best.buyName} ➜ ${best.sellName}`);
    console.log(`📈 ${best.buyName} price: ${best.buyPrice.toFixed(6)} USDC/WETH`);
    console.log(`📉 ${best.sellName} price: ${best.sellPrice.toFixed(6)} USDC/WETH`);
    console.log(`💵 Price-ratio diff: ${best.ratioPercent.toFixed(3)} %`);
    console.log(`💵 Gross profit: ${ethers.formatUnits(best.grossProfit, 6)} USDC`);
    console.log(`💵 Adjusted profit: ${ethers.formatUnits(best.adjustedProfit, 6)} USDC`);

    if (best.adjustedProfit < MIN_PROFIT_USDC) {
      console.log("❌ Below minimum profit – skipping\n");
      await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
      continue;
    }

    const vaultBefore = await usdc.balanceOf(VAULT);

    console.log("🚀 REAL PROFIT OPPORTUNITY");
    console.log("📤 Sending tx to vault...");

    const tx = await vault.executeArbitrage(
      best.buyRouter.target,
      best.sellRouter.target,
      USDC,
      WETH,
      TRADE_AMOUNT_USDC
    );

    console.log("⏳ Tx hash:", tx.hash);
    await tx.wait();

    const vaultAfter = await usdc.balanceOf(VAULT);

    console.log("💰 Vault USDC before:", ethers.formatUnits(vaultBefore, 6));
    console.log("💰 Vault USDC after:", ethers.formatUnits(vaultAfter, 6), "\n");

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

run();
