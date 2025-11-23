// improved-arbitrage-verbose.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false; // LIVE mode
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // owner wallet private key
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.01);
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);

// Routers, tokens
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, expectedProfit, netProfit }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, expectedProfit, netProfit].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ExpectedProfitUSDC","NetProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
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

async function getAmountOut(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), fallback);
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

// ---------- EXECUTE TRADE ----------
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const vaultBefore = Number(ethers.formatUnits(beforeBal, 6));

  if (amountUSDC < MIN_TRADE_USDC) {
    console.log(`❌ Skipped — ${amountUSDC} < MIN_TRADE_USDC`);
    return;
  }

  const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
  const buyPrice = amountUSDC / buyOut;
  const sellPrice = amountUSDC / sellOut;
  const expectedProfit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);

  console.log("\n🔍 ---------- New Trade Attempt ----------");
  console.log(`🔹 ${timestamp} • Token: ${tokenAddr}`);
  console.log(`💸 AmountIn: ${amountUSDC} USDC`);
  console.log(`🏦 Vault Before: ${fmt(vaultBefore)} USDC`);
  console.log(`📊 Buy DEX: ${buyRouter} @ ${fmt(buyPrice)} USDC per token`);
  console.log(`📊 Sell DEX: ${sellRouter} @ ${fmt(sellPrice)} USDC per token`);
  console.log(`📈 Expected Profit: ${fmt(expectedProfit)} USDC`);

  if (expectedProfit <= MIN_EXPECTED_PROFIT) {
    console.log(`❌ Skipped unprofitable trade`);
    return;
  }

  try {
    console.log("🚀 Executing arbitrage...");
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6)
    );
    console.log(`🔁 TX SENT — hash: ${tx.hash}`);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      console.log("❌ Transaction reverted");
      return;
    }

    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const vaultAfter = Number(ethers.formatUnits(afterBal, 6));
    const netProfit = vaultAfter - vaultBefore;

    console.log(`✅ Transaction success — gasUsed: ${receipt.gasUsed}`);
    console.log(`🏦 Vault After: ${fmt(vaultAfter)} USDC`);
    console.log(`💰 Net Profit: ${fmt(netProfit)} USDC`);

    logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, expectedProfit, netProfit });
    saveCSV();
  } catch (err) {
    console.log(`⚠️ Trade execution failed: ${err.message}`);
  }
}

// ---------- FULL SCAN ----------
async function fullScan() {
  console.log("🌲 Starting full scan of all tokens and routers...");
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy.toLowerCase() === sell.toLowerCase()) continue;
        try { await executeTrade(buy, sell, token.address, MIN_TRADE_USDC); }
        catch(e) { console.log(`⚠️ Simulation/Trade failed for ${token.address} ${buy}→${sell}: ${e.message}`); }
      }
    }
  }
  console.log("✅ Full scan completed — restarting in 30s...");
}

// ---------- MAIN LOOP ----------
(async function main() {
  await init();
  while(true) {
    try { await fullScan(); } catch(e) { console.error(e.message); }
    await new Promise(r => setTimeout(r, 30000));
  }
})();
