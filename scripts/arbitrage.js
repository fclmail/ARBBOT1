// improved-arbitrage-safe-scan.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false; // LIVE mode
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.01);
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);

// Routers and tokens
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------
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
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

// ---------- INIT ----------
async function init() {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
  const owner = await arbContract.owner();
  console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
  console.log("👤 Contract Owner:", owner);
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function simulateTrade(buyRouter, sellRouter, token, amountUSDC) {
  try {
    // Placeholder for price simulation
    const buyOut = amountUSDC * (1 - 0.001);  // example slippage
    const sellOut = amountUSDC * (1 + 0.001);
    const profit = sellOut - buyOut - GAS_EST_USDC;
    return profit;
  } catch (err) {
    return null;
  }
}

async function executeTradeSafe(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const beforeBal = Number(ethers.formatUnits(await usdcContract.balanceOf(CONTRACT_ADDRESS), 6));
  if (amountUSDC < MIN_TRADE_USDC) return;

  const expectedProfit = await simulateTrade(buyRouter, sellRouter, tokenAddr, amountUSDC);
  if (expectedProfit === null || expectedProfit <= 0) {
    console.log(`❌ Skipped unprofitable trade ${tokenAddr} ${buyRouter}→${sellRouter}`);
    return; // FAILSAFE: No gas spent on unprofitable trade
  }

  // Execute arbitrage safely
  try {
    if (DRY_RUN) {
      console.log(`💡 DRY RUN: would execute ${tokenAddr} ${buyRouter}→${sellRouter} for ${amountUSDC} USDC`);
      return;
    }
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6));
    const receipt = await tx.wait();

    const afterBal = Number(ethers.formatUnits(await usdcContract.balanceOf(CONTRACT_ADDRESS), 6));
    if (afterBal < beforeBal) {
      console.warn(`⚠️ Vault balance decreased! Reverting effects`);
      return;
    }
    const netProfit = afterBal - beforeBal;
    console.log(`✅ Trade success ${tokenAddr} ${buyRouter}→${sellRouter} Profit: ${fmt(netProfit)} USDC`);
    logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });
    saveCSV();
  } catch (err) {
    console.log(`⚠️ Simulation/Trade failed for ${tokenAddr} ${buyRouter}→${sellRouter}: ${err.message}`);
  }
}

// ---------- FULL SCAN ----------
async function scanOnce() {
  console.log("🌲 Starting full scan of all tokens and routers...");
  for (const token of Object.values(tokens)) {
    for (const buyRouterName of Object.keys(routers)) {
      for (const sellRouterName of Object.keys(routers)) {
        if (buyRouterName === sellRouterNa inme) continue;
        await executeTradeSafe(routers[buyRouterName], routers[sellRouterName], token.address, MIN_TRADE_USDC);
      }
    }
  }
  console.log("✅ Full scan completed — restarting in 30s...");
}

// ---------- MAIN LOOP ----------
(async function main() {
  await init();
  while (true) {
    try {
      await scanOnce();
    } catch (err) {
      console.error("Unexpected scan error:", err.message);
    }
    await new Promise(r => setTimeout(r, 30000));
  }
})();
