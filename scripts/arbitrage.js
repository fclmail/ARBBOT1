// improved-arbitrage.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true";
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.5);
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.01);
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01);

// Routers & tokens
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

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
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider) : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
  } catch (e) {
    console.warn("⚠️ Initialization warning:", e.message);
  }
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
    // fallback
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), fallback);
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

async function priceSanityCheck(routerAddr, token, amountUSDC) {
  try {
    const out = await getAmountOut(routerAddr, token, amountUSDC);
    return out > 0 && Number.isFinite(out);
  } catch {
    return false;
  }
}

// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };

  try {
    console.log(`\n🔍 New Trade Attempt: Token=${tokenAddr} Amount=${amountUSDC} USDC`);

    // Vault balance before
    const before = Number(ethers.formatUnits(await usdcContract.balanceOf(CONTRACT_ADDRESS), 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    if (amountUSDC < MIN_TRADE_USDC) return console.log(`⛔️ Skipping — Amount < MIN_TRADE_USDC`);

    // Pre-trade price check
    const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
    const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
    const buyPrice  = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    let expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);

    console.log(`📈 Quoted buy=${fmt(buyPrice)} | sell=${fmt(sellPrice)} | expectedProfit=${fmt(expectedProfitUSDC)} USDC`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) return console.log("❌ Expected profit too low");

    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) || !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      return console.log("⚠️ Price sanity check failed — skipping trade");
    }

    // Gas estimate
    let gasEstimate;
    try {
      gasEstimate = await arbContract.estimateGas.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6)
      );
      console.log(`⛽️ Gas Estimate: ${gasEstimate.toString()}`);
    } catch {
      console.warn("⚠️ Gas estimate failed — proceeding cautiously");
    }

    // callStatic simulation
    try {
      await arbContract.callStatic.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6),
        { from: wallet ? wallet.address : undefined }
      );
      console.log("🔬 Simulation OK — executeArbitrage callStatic passed");
    } catch (simErr) {
      return console.log("❌ SIMULATION FAILED — Trade aborted:", simErr.message.split("\n")[0]);
    }

    if (DRY_RUN) return console.log("🧪 DRY_RUN: Simulation complete — skipping actual execution");

    // Execute on-chain
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6),
      { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined }
    );
    console.log(`🚀 TX SENT — hash: ${tx.hash}`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) return console.log("❌ Transaction reverted on-chain");

    // Vault balance after
    const after = Number(ethers.formatUnits(await usdcContract.balanceOf(CONTRACT_ADDRESS), 6));
    const netProfit = after - before;
    console.log(`💰 Net Profit: ${fmt(netProfit)} USDC`);
    cumulativeProfit += netProfit;

    // CSV log
    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });

  } catch (err) {
    console.error("⚠️ Trade execution error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
async function scanOnce() {
  console.log("\n🔍 Scanning for arbitrage opportunities...");
  let opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          let profitPct = (profitUSDC / buyPrice) * 100;

          console.log(`${symbol} | ${buyName} → ${sellName} | profit=${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 PROFITABLE: executing ${symbol} ${buyName}→${sellName}`);
            opportunities.push({ symbol, tokenAddr: token.address, buyRouter, sellRouter, profitUSDC });
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn(`⚠️ Scan error for ${symbol} ${buyName}->${sellName}:`, e.message);
        }
      }
    }
  }

  saveCSV();
  console.log(`🔍 Scan complete — ${opportunities.length} candidate opportunities found.`);
  return opportunities;
}

// ---------- MAIN ----------
(async function main() {
  await init();
  console.log("🚀 Arbitrage runner started — scanning continuously every 10s");

  while (true) {
    try {
      await scanOnce();
    } catch (err) {
      console.error("⚠️ Fatal scanner error:", err.message);
    }
    await new Promise(r => setTimeout(r, 10000));
  }
})();
