// ======================================================
//  arbitrage.js  — Fully Corrected, Option-B Version
// ======================================================

import { ethers } from "ethers";

// ===== CONFIGURATION =====
const PROVIDER_URL = "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;

// *** CHECKSUM-CORRECT USDC ADDRESS ***
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// DEX Routers
const ROUTERS = {
  quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap:  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ===== PARAMS =====
const MIN_PROFIT_USDC = 0.001;       // absolute profit threshold
const MAX_PRICE_DELTA = 0.10;        // 10% max deviation allowed
const SLIPPAGE_PCT = 1;              // 1% slippage cushion
const SCAN_INTERVAL = 30000;         // 30 seconds
const TRADE_USDC = 10;               // 10 USDC test trade

// ===== ABIs =====
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function owner() view returns (address)",
  "function USDC() view returns (address)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

// ===== PROVIDER & WALLET =====
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet   = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ===== CONTRACTS =====
const vault   = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);
const usdc    = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);

// ===== TOKENS TO SCAN =====
const TOKENS = {
  CRV:  "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
  LINK: "0x53e0bca35ec356bd5dddfeBBd1FC0FD03Fabad39",
  MATIC:"0x0000000000000000000000000000000000001010"
};

// ======================================================
// Utility: get USDC balance of vault
// ======================================================
async function getVaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

// ======================================================
// Utility: getAmountsOut wrapper
// ======================================================
async function getAmountOut(router, tokenAddress, usdcAmount) {
  const routerC = new ethers.Contract(router, routerAbi, provider);
  const amountIn = ethers.parseUnits(usdcAmount.toString(), 6);

  const pathBuy  = [USDC_ADDRESS, tokenAddress];
  const pathSell = [tokenAddress, USDC_ADDRESS];

  let buyOut, sellOut;
  try {
    buyOut  = await routerC.getAmountsOut(amountIn, pathBuy);
    sellOut = await routerC.getAmountsOut(amountIn, pathSell);
  } catch (err) {
    throw new Error("router failed: " + err.message);
  }

  return {
    buyTokenOut: Number(ethers.formatUnits(buyOut[1])),
    sellTokenOut: Number(ethers.formatUnits(sellOut[1]))
  };
}

// ======================================================
// OPTION-B PRICE-SPREAD MATH
// ======================================================
function computeMetrics(buyAmountOut, sellAmountOut, tradeAmount) {
  const buyPrice  = tradeAmount / buyAmountOut;
  const sellPrice = tradeAmount / sellAmountOut;

  let profit = sellPrice - buyPrice;
  profit *= (1 - SLIPPAGE_PCT / 100);

  const profitPct = (profit / buyPrice) * 100;

  return { buyPrice, sellPrice, profit, profitPct };
}

// ======================================================
// MAIN SCAN LOOP
// ======================================================
async function scanOnce() {

  console.log("\n🔍 Scanning for arbitrage opportunities...\n");

  let vaultBefore = await getVaultBalance();
  console.log(`🏦 Vault balance: ${vaultBefore.toFixed(6)} USDC\n`);

  let found = 0;
  let scanId = 0;

  for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
    for (const [buyName, buyRouter] of Object.entries(ROUTERS)) {
      for (const [sellName, sellRouter] of Object.entries(ROUTERS)) {

        if (buyName === sellName) continue;
        scanId++;

        console.log(`🔎 Scan #${scanId} | ${symbol} | ${buyName} → ${sellName}`);

        let amounts;
        try {
          amounts = await getAmountOut(buyRouter, tokenAddress, TRADE_USDC);
        } catch (err) {
          console.log(`⚠ Router failure: ${err.message}`);
          continue;
        }

        const metrics = computeMetrics(
          amounts.buyTokenOut,
          amounts.sellTokenOut,
          TRADE_USDC
        );

        console.log(
          `   buyPrice=$${metrics.buyPrice.toFixed(6)} | sellPrice=$${metrics.sellPrice.toFixed(6)}`
        );
        console.log(
          `   spread=${metrics.profit.toFixed(6)} USDC (${metrics.profitPct.toFixed(4)}%)`
        );

        // ===== FailSafe #1 — price deviation filter =====
        const deviationPct =
          ((Math.abs(metrics.buyPrice - metrics.sellPrice) /
          ((metrics.buyPrice + metrics.sellPrice) / 2)) * 100);

        if (deviationPct > MAX_PRICE_DELTA * 100) {
          console.log(
            `⚠ Price deviation = ${deviationPct.toFixed(2)}% ` +
            `(>${(MAX_PRICE_DELTA * 100).toFixed(2)}%) — Rejected`
          );
          continue;
        }

        // ===== FailSafe #2 — Minimum profit threshold =====
        if (metrics.profit < MIN_PROFIT_USDC) {
          console.log(`❌ Profit too small — Rejected`);
          continue;
        }

        console.log(`💰 PROFITABLE — checking callStatic...`);

        // ===== FailSafe #3 — callStatic simulation =====
        try {
          await vault.callStatic.executeArbitrage(
            buyRouter,
            sellRouter,
            tokenAddress,
            ethers.parseUnits(TRADE_USDC.toString(), 6)
          );
        } catch (err) {
          console.log(`❌ callStatic blocked trade — SAFE`);
          continue;
        }

        console.log(`🚀 Executing trade...`);

        // ===== Execute real trade =====
        const tx = await vault.executeArbitrage(
          buyRouter,
          sellRouter,
          tokenAddress,
          ethers.parseUnits(TRADE_USDC.toString(), 6)
        );

        console.log(`⏳ txHash: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status !== 1) {
          console.log(`❌ Execution failed — skipped`);
          continue;
        }

        // ===== FailSafe #4 — Vault must increase =====
        const vaultAfter = await getVaultBalance();

        if (vaultAfter > vaultBefore) {
          console.log(
            `✅ PROFIT CONFIRMED — Vault increased: +${(vaultAfter - vaultBefore).toFixed(6)} USDC`
          );
          vaultBefore = vaultAfter;
          found++;
        } else {
          console.log(`❌ Vault did NOT increase — FAILSAFE triggered`);
        }
      }
    }
  }

  console.log(`\n🎯 Scan complete — profitable: ${found}\n`);
}

// ======================================================
// LOOP FOREVER
// ======================================================
async function loop() {
  console.log("🚀 LIVE MODE ENABLED — FULL FAILSAFE CHECKS\n");

  const owner = await vault.owner();
  console.log("🏛 Contract:", VAULT_ADDRESS);
  console.log("👤 Owner:", owner);

  while (true) {
    await scanOnce();
    console.log(`⏳ Waiting ${SCAN_INTERVAL / 1000}s...\n`);
    await new Promise(r => setTimeout(r, SCAN_INTERVAL));
  }
}

// RUN
loop().catch(err => console.error("Fatal:", err));
