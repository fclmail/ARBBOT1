// scripts/arbitrage.js
// ---------------------------------------------------------
// ARBBOT1 – LIVE PRICE LOGGING + PROFIT-SAFE EXECUTION
// Polygon Mainnet
// ---------------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------
// RPC / WALLET
// ---------------------------------------------------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ---------------------------------------------------------
// ADDRESSES (POLYGON)
// ---------------------------------------------------------
const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const VAULT = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6);
const MIN_PROFIT_USDC  = ethers.parseUnits("0.01", 6);
const SAFETY_BPS = 8500n; // 85%
const LOOP_DELAY = 2000;

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
  "function executeArbitrage(address,address,address,address,uint256) external"
];

// ---------------------------------------------------------
// CONTRACTS
// ---------------------------------------------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

// ---------------------------------------------------------
// SIMULATION
// ---------------------------------------------------------
async function simulate(buyRouter, sellRouter) {
  const buy = await buyRouter.getAmountsOut(
    TRADE_AMOUNT_USDC,
    [USDC, WETH]
  );

  const wethOut = buy[1];
  if (wethOut === 0n) return null;

  const sell = await sellRouter.getAmountsOut(
    wethOut,
    [WETH, USDC]
  );

  const usdcOut = sell[1];
  if (usdcOut <= TRADE_AMOUNT_USDC) return null;

  const grossProfit = usdcOut - TRADE_AMOUNT_USDC;
  const adjustedProfit = (grossProfit * SAFETY_BPS) / 10_000n;
  const feeLoss = grossProfit - adjustedProfit;

  const buyPrice =
    Number(TRADE_AMOUNT_USDC) / Number(wethOut);

  const sellPrice =
    Number(usdcOut) / Number(wethOut);

  return {
    wethOut,
    buyPrice,
    sellPrice,
    grossProfit,
    adjustedProfit,
    feeLoss
  };
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
  console.log(
    "⏱",
    new Date().toISOString(),
    "Polygon Arb Bot Started"
  );

  while (true) {
    console.log("🔍 QuickSwap ➜ SushiSwap");

    const vaultBefore = await usdc.balanceOf(VAULT);

    const sim = await simulate(quickRouter, sushiRouter);

    if (!sim) {
      console.log("⚠️ No executable profit\n");
      await new Promise(r => setTimeout(r, LOOP_DELAY));
      continue;
    }

    console.log(
      `📈 QuickSwap price: ${sim.buyPrice.toFixed(6)} USDC/WETH`
    );
    console.log(
      `📉 SushiSwap price: ${sim.sellPrice.toFixed(6)} USDC/WETH`
    );

    console.log(
      "💵 Gross price gap profit:",
      ethers.formatUnits(sim.grossProfit, 6),
      "USDC"
    );

    console.log(
      "💵 Fees + slippage:",
      ethers.formatUnits(sim.feeLoss, 6),
      "USDC"
    );

    console.log(
      "💵 Adjusted profit (85%):",
      ethers.formatUnits(sim.adjustedProfit, 6),
      "USDC"
    );

    if (sim.adjustedProfit >= MIN_PROFIT_USDC) {
      console.log(
        `✅ MIN PROFIT = ${ethers.formatUnits(MIN_PROFIT_USDC, 6)} USDC satisfied`
      );
      console.log("🚀 Executing arbitrage...");

      console.log(
        "💰 Vault USDC before:",
        ethers.formatUnits(vaultBefore, 6)
      );

      const tx = await vault.executeArbitrage(
        QUICK_ROUTER,
        SUSHI_ROUTER,
        USDC,
        WETH,
        TRADE_AMOUNT_USDC
      );

      await tx.wait();

      const vaultAfter = await usdc.balanceOf(VAULT);

      console.log(
        "💰 Vault USDC after:",
        ethers.formatUnits(vaultAfter, 6),
        "\n"
      );
    } else {
      console.log("❌ Below minimum profit – skipping\n");
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY));
  }
}

run();
