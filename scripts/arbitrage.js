// 🔹 AAVE FLASH ARB BOT — LIVE VERSION WITH VAULT DEPOSIT
//    (REAL TRANSACTIONS ON POLYGON)
//    All failsafes included, callStatic/log fixes applied

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// 🟢 DRY_RUN TOGGLE: set to true to simulate only (no on-chain tx), false to run live
const DRY_RUN = false;
const COOLDOWN_MS = 5000; // cooldown on failure
console.log(`🚀 LIVE MODE ENABLED — ${DRY_RUN ? "Simulation Only" : "REAL TRADES WILL BE EXECUTED"}\n`);

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Existing contract as vault
const MIN_NET_PROFIT_USDC = 0.0001;

// Provider + Signer
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ─────────────── CONTRACT 🟢2 ───────────────
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
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// Fetch vault owner
(async () => {
  try {
    console.log("🏛 Vault Contract:", CONTRACT_ADDRESS);
    const owner = await arbContract.owner();
    console.log("👤 Vault Owner:", owner);
  } catch (err) {
    console.warn("⚠️ Could not fetch contract owner:", err.message);
  }
})();

// ─────────────── ROUTERS 🟢3 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS 🟢4 ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── SETTINGS 🟢5 ───────────────
const TRADE_AMOUNT_USDC = 0.001;
const MIN_PROFIT_PCT = 0.5;
const SLIPPAGE_PCT = 0.2;

// ─────────────── HELPERS 🟢6 ───────────────
function fmt(n, dec = 4) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      fallback
    );
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

// ─────────────── CUMULATIVE PROFIT 🟢7 ───────────────
let cumulativeProfit = 0;

// ─────────────── CSV LOGGING 🟢8 ───────────────
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profit].join(","));
}
function saveCSV() {
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const csvContent = [header.join(","), ...csvRows].join("\n");
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, csvContent);
  console.log(`💾 Trades exported to CSV: ${filename}`);
}

// ─────────────── USDC CONTRACT 🟢9 ───────────────
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];
let usdcContract;
(async () => {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
})();

// ─────────────── TRADE EXECUTOR 🟢10 ───────────────
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amount) {
  const timestamp = new Date().toISOString();

  // Vault before
  const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const before = Number(ethers.formatUnits(beforeBal, 6));

  // CallStatic simulation
  try {
    await arbContract.connect(wallet).callStatic.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
    );
  } catch (simErr) {
    console.log(`❌ callStatic failed — abort trade: ${simErr.reason || simErr.message}`);
    await new Promise(r => setTimeout(r, COOLDOWN_MS));
    return;
  }

  // JS pre-profit check
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  let buyOut, sellOut;
  try {
    buyOut = await getAmountOut(buyRouter, tokenObj, amount);
    sellOut = await getAmountOut(sellRouter, tokenObj, amount);
  } catch { console.log("❌ Price query failed"); return; }

  const buyPrice = amount / buyOut;
  const sellPrice = amount / sellOut;
  let expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
  if (expectedProfitUSDC < MIN_NET_PROFIT_USDC) {
    console.log(`❌ Profit below threshold after slippage: ${expectedProfitUSDC}`); return;
  }

  // Gas estimate guard
  const gasEstimate = await arbContract.connect(wallet).estimateGas.executeArbitrage(
    buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
  );
  const gasPrice = await provider.getGasPrice();
  const gasCostUSDC = Number(ethers.formatUnits(gasEstimate.mul(gasPrice), 6));
  if (gasCostUSDC > expectedProfitUSDC) {
    console.log(`❌ Gas cost ${gasCostUSDC} USDC > expected profit ${expectedProfitUSDC} — abort`);
    return;
  }

  // Execute TX
  if (!DRY_RUN) {
    try {
      const tx = await arbContract.connect(wallet).executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
      );
      const receipt = await tx.wait();
      if (!receipt || receipt.status === 0 || !receipt.transactionHash) {
        console.log("❌ Transaction failed — vault unchanged"); return;
      }
    } catch (err) {
      console.log(`❌ TX failed: ${err.reason || err.message}`);
      await new Promise(r => setTimeout(r, COOLDOWN_MS));
      return;
    }
  }

  // Vault after
  const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const after = Number(ethers.formatUnits(afterBal, 6));
  if (after <= before) {
    console.log("❌ Vault did not increase — trade ignored");
    return;
  }

  // Real profit
  const netProfit = after - before;
  cumulativeProfit += netProfit;
  console.log(`✅ Trade successful: ${tokenAddr} | Net Profit: ${netProfit.toFixed(6)} USDC | Cumulative: ${cumulativeProfit.toFixed(6)} USDC`);

  // CSV logging
  const symbolEntry = Object.entries(tokens).find(([k, t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
  const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
  logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit: netProfit });
}

// ─────────────── SCAN LOOP 🟢11 ───────────────
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

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
          let profitPct = (profitUSDC / buyPrice) * 100 * (1 - SLIPPAGE_PCT / 100);

          console.log(`${symbol} | ${buyName} $${fmt(buyPrice)} → ${sellName} $${fmt(sellPrice)} | Est. Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ symbol, buyName, sellName });
            console.log(`🚨 PROFITABLE: executing ${symbol} ${buyName}→${sellName}`);
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (err) {
          console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}: ${err.reason || err.message}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Opportunities found: ${opportunities.length}\n`);
  saveCSV();
  return opportunities;
}

// ─────────────── MAIN LOOP 🟢12 ───────────────
async function main() {
  console.log("🚀 Live Aave Flash Arbitrage Bot with Vault Started\n");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
