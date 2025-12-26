// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – FIXED & SAFE VERSION
//  ✔ Correct buy → sell math
//  ✔ Correct router simulation
//  ✔ No fake profit logs
//  ✔ TX hashes + real profit now appear
// ---------------------------------------------------------

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true";
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.002);
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01);
const MIN_TRADE_USDC = 0.01;
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);
const MAX_PROFIT_PCT = 40;
const VAULT_GUARD_DROP_PCT = 20;

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ---------- CSV LOGGING ----------
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, profitPct }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, profitPct].join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","ProfitPct"];
  fs.writeFileSync(`arbitrage_log_${Date.now()}.csv`, [header.join(","), ...csvRows].join("\n"));
  console.log("💾 CSV exported");
}

// ---------- PROVIDER ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT ABI ----------
const arbAbi = [
  "function executeArbitrage(address,address,address,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)"
];

const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  arbAbi,
  wallet || provider
);

// ---------- ERC20 ----------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

let usdcContract;
let usdcDecimals = 6;

// ---------- INIT ----------
async function init() {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
  usdcDecimals = await usdcContract.decimals();
  console.log("🏛 Vault:", CONTRACT_ADDRESS);
  console.log("💵 USDC :", usdcAddr);
  console.log("🔢 Decimals:", usdcDecimals.toString());
}

// ---------- HELPERS ----------
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ---------- AMOUNT OUT ----------
async function getBuyOut(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint,address[]) view returns (uint[])"],
    provider
  );
  const usdcAddr = await arbContract.USDC();
  const path = [usdcAddr, token.address];

  const amounts = await router.getAmountsOut(
    ethers.parseUnits(amountUSDC.toString(), usdcDecimals),
    path
  );
  return Number(ethers.formatUnits(amounts[1], token.decimals));
}

// ---------- CORE EXECUTION ----------
let initialVaultBalance = null;
let vaultGuardActive = true;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const token = Object.values(tokens).find(t => t.address === tokenAddr);

  try {
    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, usdcDecimals));
    if (!initialVaultBalance) initialVaultBalance = before;

    if (vaultGuardActive && before < initialVaultBalance * (1 - VAULT_GUARD_DROP_PCT / 100)) {
      vaultGuardActive = false;
      console.warn("🛑 Vault guard triggered — trading stopped");
      return;
    }

    if (!vaultGuardActive || amountUSDC < MIN_TRADE_USDC) return;

    console.log(`\n🔍 ${timestamp} | ${tokenAddr}`);
    console.log(`🏦 Vault Before: ${fmt(before)} USDC`);

    // ---- BUY ----
    const buyOut = await getBuyOut(buyRouter, token, amountUSDC);

    // ---- SELL ----
    const sellRouterContract = new ethers.Contract(
      sellRouter,
      ["function getAmountsOut(uint,address[]) view returns (uint[])"],
      provider
    );
    const usdcAddr = await arbContract.USDC();
    const sellAmounts = await sellRouterContract.getAmountsOut(
      ethers.parseUnits(buyOut.toString(), token.decimals),
      [token.address, usdcAddr]
    );

    const sellUSDC = Number(ethers.formatUnits(sellAmounts[1], usdcDecimals));

    const expectedProfitUSDC = sellUSDC - amountUSDC;
    const expectedProfitPct = (expectedProfitUSDC / amountUSDC) * 100;

    console.log(`🔹 BuyOut: ${fmt(buyOut, token.decimals)}`);
    console.log(`🔹 SellBack: ${fmt(sellUSDC)} USDC`);
    console.log(`🔹 Expected Profit: ${fmt(expectedProfitUSDC)} USDC (${fmt(expectedProfitPct)}%)`);

    if (
      expectedProfitPct < MIN_PROFIT_PCT ||
      expectedProfitPct > MAX_PROFIT_PCT
    ) return;

    // ---- SIMULATION ----
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [
          buyRouter,
          sellRouter,
          token.address,
          ethers.parseUnits(amountUSDC.toString(), usdcDecimals)
        ]),
        from: wallet?.address
      });
      console.log("🔬 Simulation OK");
    } catch {
      console.warn("🛑 Simulation reverted — skipping");
      return;
    }

    if (DRY_RUN) {
      console.log("🧪 DRY RUN — trade skipped");
      return;
    }

    // ---- EXECUTE ----
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amountUSDC.toString(), usdcDecimals)
    );

    console.log("🔁 TX SENT:", tx.hash);
    const receipt = await tx.wait();

    if (!receipt.status) {
      console.warn("❌ TX reverted");
      return;
    }

    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, usdcDecimals));
    const netProfit = after - before;
    const netProfitPct = (netProfit / before) * 100;

    console.log("✅ TX MINED:", receipt.transactionHash);
    console.log(`💰 REAL PROFIT: ${fmt(netProfit)} USDC`);
    console.log(`📊 NET PROFIT %: ${fmt(netProfitPct)}%`);

    logTradeCSV({
      timestamp,
      symbol: tokenAddr,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profitUSDC: netProfit,
      profitPct: netProfitPct
    });

  } catch (err) {
    console.warn("⚠️ Trade skipped:", err.message);
  }
}

// ---------- SCANNER ----------
async function scanAllPairs() {
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await executeTradeLive(buy, sell, token.address, TRADE_AMOUNT_USDC);
      }
    }
  }
  saveCSV();
}

// ---------- MAIN ----------
(async function main() {
  await init();
  console.log("🚀 Arbitrage bot running");
  setInterval(scanAllPairs, 10_000);
})();
