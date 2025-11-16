// ───────────────────────────────────────────── 
// 🔹 AAVE FLASH ARB BOT — DRY RUN VERSION
//    (NO REAL TRANSACTIONS, NO GAS USED)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
import * as XLSX from "xlsx";
import fs from "fs";
dotenv.config();

// 🟢 DRY RUN ALWAYS ON – SAFE MODE
const DRY_RUN = true;
console.log(`🧪 DRY RUN MODE ENABLED — NO REAL TRADES WILL BE EXECUTED\n`);

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; 
const MIN_NET_PROFIT_USDC = 1;
const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;
const SCAN_INTERVAL_MS = 5000;
const EXPORT_FOLDER = process.env.EXPORT_FOLDER || ".";

// Provider ONLY (wallet unnecessary in dry run)
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ─────────────── STUB CONTRACT (NO WALLET NEEDED) 🟢2 ───────────────
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

(async () => {
  console.log("🏛 Contract Address:", await arbContract.getAddress());
  console.log("👤 Contract Owner:", await arbContract.owner());
})();

// ─────────────── ROUTERS 🟢3 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS 🟢4 ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── HELPERS 🟢5 ───────────────
function fmt(n, dec = 4) {
  if (!n) return "0";
  return Number(n).toFixed(dec);
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), fallback);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── CUMULATIVE PROFIT 🟢6 ───────────────
let cumulativeProfit = 0;
const results = [];

// ─────────────── SIMULATED TRADE EXECUTOR 🟢7 ───────────────
async function executeTradeSimulated(buyRouter, sellRouter, tokenAddr, amount, profitUSDC) {
  console.log("🧪 ---------------------------------------");
  console.log("🧪 DRY RUN — Simulating trade execution");
  console.log("🧪 Buy Router:", buyRouter);
  console.log("🧪 Sell Router:", sellRouter);
  console.log("🧪 Token:", tokenAddr);
  console.log("🧪 AmountIn:", amount);

  cumulativeProfit += profitUSDC;

  console.log(`🧪 Simulated Net Profit: ${profitUSDC.toFixed(6)} USDC`);
  console.log(`🧪 Cumulative Profit: ${cumulativeProfit.toFixed(6)} USDC`);
  console.log("🧪 ---------------------------------------\n");

  // Store for XLSX export
  results.push({
    timestamp: new Date().toISOString(),
    buyRouter, sellRouter, tokenAddr, amount, profitUSDC
  });
}

// ─────────────── XLSX EXPORT 🟢8 ───────────────
function exportXLSX(resultsArray) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${EXPORT_FOLDER}/arb-results-${timestamp}.xlsx`;
  const worksheet = XLSX.utils.json_to_sheet(resultsArray);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "ArbResults");
  XLSX.writeFile(workbook, filename);
  console.log(`💾 Exported results to ${filename}`);
  return filename;
}

// ─────────────── SCAN LOOP 🟢9 ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...\n");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {

        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct  = (profitUSDC / buyPrice) * 100;

          profitUSDC *= 1 - SLIPPAGE_PCT / 100;
          profitPct  *= 1 - SLIPPAGE_PCT / 100;

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ symbol, buyName, sellName, profitUSDC, profitPct });

            console.log(
              `🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`
            );

            await executeTradeSimulated(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC, profitUSDC);
          }

        } catch (err) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}:`, err.message);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} profitable opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP 🟢10 ───────────────
async function main() {
  console.log("🚀 DRY RUN Aave Flash Arbitrage Bot Started\n");

  process.on("SIGINT", () => { exportXLSX(results); process.exit(0); });
  process.on("SIGTERM", () => { exportXLSX(results); process.exit(0); });

  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(console.error);


