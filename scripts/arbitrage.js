// arb.js
// Full arbitrage dry-run with getAmountsOut, callStatic, debug, cumulative profit, XLSX export
// - Uses real DEX router prices (getAmountsOut) instead of random math
// - Simulates executeArbitrage via callStatic (no txs sent)

import { ethers } from "ethers";
import dotenv from "dotenv";
import * as XLSX from "xlsx";
import fs from "fs";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const DRY_RUN = process.env.DRY_RUN ? process.env.DRY_RUN === "true" : true;
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.04);
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 3);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5000);
const EXPORT_FOLDER = process.env.EXPORT_FOLDER || ".";

// ----------------- PROVIDER & CONTRACT -----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);

const arbAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { inputs: [], name: "USDC", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// ----------------- ROUTERS & TOKENS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ----------------- Runtime tracking -----------------
let cumulativeProfit = 0;
const results = [];

// ----------------- UTILITIES -----------------
function fmt(n, dec = 4) {
  if (typeof n === "undefined" || n === null || Number.isNaN(Number(n))) return "NaN";
  return Number(n).toFixed(dec);
}

async function safeGetUSDCAddress() {
  try {
    return await arbContract.USDC();
  } catch (e) {
    console.warn("⚠️ Failed reading USDC() from contract; using default USDC address. Error:", e.message || e);
    return "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
  }
}

// ----------------- getAmountOut using router.getAmountsOut -----------------
async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdcAddress = await safeGetUSDCAddress();
  const pathDirect = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), pathDirect);
    const last = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(last, token.decimals));
  } catch (errDirect) {
    // fallback: USDC -> WBTC -> token
    try {
      const path2 = [usdcAddress, tokens.WBTC.address, token.address];
      const amounts2 = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path2);
      const last = amounts2[amounts2.length - 1];
      return Number(ethers.formatUnits(last, token.decimals));
    } catch (errFallback) {
      throw new Error(`getAmountOut failed on router ${routerAddr}: ${errFallback.message || errFallback}`);
    }
  }
}

// ----------------- simulateArbCall (callStatic) -----------------
async function simulateArbCall(buyRouter, sellRouter, tokenAddr, amountIn) {
  try {
    await arbContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountIn.toString(), 6)
    );
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err };
  }
}

function decodeStaticCallError(err) {
  console.log("\n──────────────── STATIC CALL DEBUG START ────────────────");
  try {
    console.log("error.name:", err && err.name);
    console.log("error.code:", err && err.code);
    if (err && err.reason) console.log("revert reason:", err.reason);
    if (err && err.message) console.log("message:", err.message);
  } catch {}
  console.log("──────────────── STATIC CALL DEBUG END ─────────────────\n");
}

// ----------------- simulated executor -----------------
async function executeTradeSimulated(buyRouter, sellRouter, tokenAddr, amount, computedProfitUSDC) {
  console.log("🧪 ---------- Simulated Trade Execution ----------");
  console.log("🧪 buyRouter:", buyRouter);
  console.log("🧪 sellRouter:", sellRouter);
  console.log("🧪 token:", tokenAddr);
  console.log("🧪 probeAmount (USDC):", amount);

  let simulatedNet = Number(computedProfitUSDC ?? (Math.random() * 0.01));
  cumulativeProfit += simulatedNet;
  console.log(`💹 [SIM] Net USDC change (simulated): ${simulatedNet.toFixed(6)} USDC`);
  console.log(`📊 [SIM] Cumulative USDC profit: ${cumulativeProfit.toFixed(6)} USDC`);
  console.log("🧪 ---------------------------------------------\n");
  return simulatedNet;
}

// ----------------- XLSX export -----------------
function exportXLSX(resultsArray) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${EXPORT_FOLDER}/arb-results-${timestamp}.xlsx`;
    const worksheet = XLSX.utils.json_to_sheet(resultsArray);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "ArbResults");
    XLSX.writeFile(workbook, filename);
    console.log(`💾 Exported results to ${filename}`);
    return filename;
  } catch (e) {
    console.error("Failed to export XLSX:", e);
    return null;
  }
}

// ----------------- SCAN LOOP -----------------
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          // ✅ replace random math with real getAmountsOut
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          if (!buyOut || !sellOut) continue;

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct *= (1 - SLIPPAGE_PCT / 100);

          console.log(`PAIR ${symbol} | ${buyName}->${sellName} | buyOut:${fmt(buyOut,6)} sellOut:${fmt(sellOut,6)} | profitUSDC:${fmt(profitUSDC,6)} pct:${fmt(profitPct,2)}%`);

          if (profitPct >= MIN_PROFIT_PCT) {
            const simRes = await simulateArbCall(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);

            if (!simRes.success) {
              console.warn("❌ callStatic failed");
              decodeStaticCallError(simRes.error);

              const row = {
                timestamp: new Date().toISOString(),
                token: symbol,
                buy: buyName,
                sell: sellName,
                buyOut,
                sellOut,
                buyPrice,
                sellPrice,
                profitUSDC,
                profitPct,
                staticSuccess: false,
                staticError: (simRes.error && (simRes.error.reason || simRes.error.message)) || "unknown"
              };
              results.push(row);
              opportunities.push(row);
            } else {
              const simulatedNet = await executeTradeSimulated(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC, profitUSDC);

              const row = {
                timestamp: new Date().toISOString(),
                token: symbol,
                buy: buyName,
                sell: sellName,
                buyOut,
                sellOut,
                buyPrice,
                sellPrice,
                profitUSDC,
                profitPct,
                staticSuccess: true,
                simulatedNet,
              };
              results.push(row);
              opportunities.push(row);
            }
          }
        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}:`, e.message || e);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Opportunities found: ${opportunities.length}`);
  return opportunities;
}

// ----------------- MAIN -----------------
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot (DRY-RUN with getAmountsOut + callStatic)");

  try {
    const owner = await arbContract.owner();
    const usdc = await arbContract.USDC();
    console.log(`👤 Contract owner: ${owner}`);
    console.log(`💵 Contract USDC address: ${usdc}`);
  } catch (e) {
    console.warn("⚠️ Could not read contract owner/USDC:", e.message || e);
  }

  while (true) {
    try {
      await scan();
    } catch (err) {
      console.error("Fatal error during scan:", err);
    }
    await new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

// ----------------- graceful exit & export -----------------
async function handleExit(signal) {
  try {
    console.log(`\nReceived ${signal} — exporting results (${results.length} rows) and exiting.`);
    if (results.length > 0) exportXLSX(results);
    else console.log("No results to export.");
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => handleExit("SIGINT"));
process.on("SIGTERM", () => handleExit("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  handleExit("uncaughtException");
});

// Start
main().catch((err) => {
  console.error("Unhandled startup error:", err);
  process.exit(1);
});


