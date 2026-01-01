// scripts/arbitrage.js
// ---------------------------------------------------------
// ARBBOT1 – FULL LOGGING + PROFIT-SAFE VERSION (POLYGON)
// ---------------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------
// RPC / WALLET
// ---------------------------------------------------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL || !PRIVATE_KEY) {
  throw new Error("❌ Missing RPC_URL or PRIVATE_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------------------------------------------------
// HARDCODED POLYGON ADDRESSES
// ---------------------------------------------------------
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH  = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// 🔴 MUST be real deployed vault
const VAULT = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

if (!ethers.isAddress(VAULT)) {
  throw new Error("❌ Invalid VAULT address – deploy vault and paste address");
}

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6);
const MIN_PROFIT_BPS = 10n;      // 0.10%
const SAFETY_BPS = 8500n;        // 85%
const LOOP_DELAY_MS = 2000;

// ---------------------------------------------------------
// ABIs
// ---------------------------------------------------------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const VAULT_ABI = [
  "function executeArbitrage(address,address,address,address,uint256) external",
  "function balance() view returns (uint256)"
];

// ---------------------------------------------------------
// CONTRACTS
// ---------------------------------------------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);

const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);

// ---------------------------------------------------------
// MIN PROFIT (ABSOLUTE)
// ---------------------------------------------------------
const minProfitUSDC =
  (TRADE_AMOUNT_USDC * MIN_PROFIT_BPS) / 10_000n;

// ---------------------------------------------------------
// FULL-PATH SIMULATION
// ---------------------------------------------------------
async function simulateArbitrage(routerBuy, routerSell) {
  const buy = await routerBuy.getAmountsOut(
    TRADE_AMOUNT_USDC,
    [USDC, WETH]
  );

  const wethOut = buy[1];
  if (wethOut === 0n) return null;

  const sell = await routerSell.getAmountsOut(
    wethOut,
    [WETH, USDC]
  );

  const usdcOut = sell[1];
  if (usdcOut <= TRADE_AMOUNT_USDC) return null;

  const rawProfit = usdcOut - TRADE_AMOUNT_USDC;
  const adjustedProfit = (rawProfit * SAFETY_BPS) / 10_000n;
  const profitPct =
    Number(rawProfit * 10_000n / TRADE_AMOUNT_USDC) / 100;

  return {
    wethOut,
    rawProfit,
    adjustedProfit,
    profitPct,
    buyPrice: Number(TRADE_AMOUNT_USDC) / Number(wethOut),
    sellPrice: Number(usdcOut) / Number(wethOut)
  };
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
  console.log("⏱", new Date().toISOString(), "Polygon Arb Bot Started");

  while (true) {
    console.log("🔍 QuickSwap ➜ SushiSwap");

    // Balances
    const vaultBefore = await usdc.balanceOf(VAULT);
    const walletMatic = await provider.getBalance(wallet.address);

    console.log(
      "🏦 Vault USDC:",
      ethers.formatUnits(vaultBefore, 6)
    );
    console.log(
      "👛 Wallet MATIC:",
      ethers.formatEther(walletMatic)
    );

    const sim = await simulateArbitrage(quickRouter, sushiRouter);

    if (!sim) {
      console.log("⚠️ No real profit after fees – skipping\n");
      await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
      continue;
    }

    console.log(
      `📈 Buy  Dex: QuickSwap @ ${sim.buyPrice.toFixed(6)} USDC/WETH`
    );
    console.log(
      `📉 Sell Dex: SushiSwap @ ${sim.sellPrice.toFixed(6)} USDC/WETH`
    );

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

    console.log(
      "📊 Profit %:",
      sim.profitPct.toFixed(3),
      "%"
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

      const vaultAfter = await usdc.balanceOf(VAULT);

      console.log(
        "🏦 Vault USDC After:",
        ethers.formatUnits(vaultAfter, 6)
      );
      console.log("✅ Arbitrage completed\n");
    } else {
      console.log("⚠️ Below vault min profit – skipping\n");
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

run();
