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
// TOKEN ADDRESSES
// ---------------------------------------------------------
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// ---------------------------------------------------------
// DEX ROUTERS
// ---------------------------------------------------------
const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// ---------------------------------------------------------
// VAULT (HARDCODED)
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
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
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
// PRICE-RATIO SCAN (UNCHANGED LOGIC)
// ---------------------------------------------------------
async function scanOpportunity(buyRouter, sellRouter, buyName, sellName) {
  const buy = await buyRouter.getAmountsOut(TRADE_AMOUNT_USDC, [USDC, WETH]);
  const wethOut = buy[1];
  if (wethOut === 0n) return null;

  const sell = await sellRouter.getAmountsOut(wethOut, [WETH, USDC]);
  const usdcBack = sell[1];

  const buyPrice  = Number(TRADE_AMOUNT_USDC) / Number(wethOut);
  const sellPrice = Number(usdcBack) / Number(wethOut);

  const grossProfit    = usdcBack - TRADE_AMOUNT_USDC;
  const adjustedProfit = (grossProfit * SAFETY_BPS) / 10_000n;
  const ratioPct       = ((sellPrice - buyPrice) / buyPrice) * 100;

  return {
    buyRouter,
    sellRouter,
    buyName,
    sellName,
    buyPrice,
    sellPrice,
    ratioPct,
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
    console.log("\n⏱ Scan:", new Date().toISOString());

    const scans = [];

    scans.push(await scanOpportunity(quickRouter, sushiRouter, "QuickSwap", "SushiSwap"));
    scans.push(await scanOpportunity(sushiRouter, quickRouter, "SushiSwap", "QuickSwap"));

    let executed = false;

    for (const opp of scans) {
      if (!opp) continue;

      console.log(`🔍 ${opp.buyName} ➜ ${opp.sellName}`);
      console.log(`📈 ${opp.buyName} price: ${opp.buyPrice.toFixed(6)} USDC/WETH`);
      console.log(`📉 ${opp.sellName} price: ${opp.sellPrice.toFixed(6)} USDC/WETH`);
      console.log(`💵 Price-ratio diff: ${opp.ratioPct.toFixed(3)} %`);
      console.log(`💵 Simulated gross profit: ${ethers.formatUnits(opp.grossProfit, 6)} USDC`);
      console.log(`💵 Simulated adjusted profit: ${ethers.formatUnits(opp.adjustedProfit, 6)} USDC`);

      if (opp.adjustedProfit < MIN_PROFIT_USDC) {
        console.log("❌ Below minimum profit – not executing\n");
        continue;
      }

      const before = await usdc.balanceOf(VAULT);

      console.log("🚀 REAL PROFIT OPPORTUNITY");
      console.log("📤 Sending tx to vault...");

      const tx = await vault.executeArbitrage(
        opp.buyRouter.target,
        opp.sellRouter.target,
        USDC,
        WETH,
        TRADE_AMOUNT_USDC
      );

      console.log("⏳ Tx hash:", tx.hash);
      await tx.wait();

      const after = await usdc.balanceOf(VAULT);

      console.log("💰 Vault USDC before:", ethers.formatUnits(before, 6));
      console.log("💰 Vault USDC after :", ethers.formatUnits(after, 6));

      executed = true;
      break;
    }

    if (!executed) {
      console.log("⚠️ No executable arbitrage this cycle");
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

run();
