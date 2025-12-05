// improved-arbitrage.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true" ? true : false;
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // must be set for live mode
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.5);     // min % (script-level)
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.1);    // Don't trade < this USDC
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);       // conservative gas estimate in USDC
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001); // very small floor
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);

// Routers, tokens (copy your original)
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
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT (same minimal ABI you used) ----------
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

// getAmountsOut wrapper (returns number)
async function getAmountOut(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountUSDC.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    // fallback path attempt
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountUSDC.toString(), 6),
      fallback
    );
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

// sanity function to test getAmountsOut viability
async function priceSanityCheck(routerAddr, token, amountUSDC) {
  try {
    const out = await getAmountOut(routerAddr, token, amountUSDC);
    // tiny token outputs are suspicious for large slippage; check > 0
    return out > 0 && Number.isFinite(out);
  } catch (e) {
    return false;
  }
}

// ---------- CORE: executeTradeLive with all failsafes and emoji emissions ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);
    // 1) Vault balance before
    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    // 2) Quick sanity: amount must be >= MIN_TRADE_USDC
    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`⛔️ Skipping — Amount ${amountUSDC} USDC < MIN_TRADE_USDC ${MIN_TRADE_USDC} USDC`);
      return;
    }

    // 3) Option 1: Pre-profit check using on-chain getAmountsOut (no tx)
    let buyOut, sellOut;
    try {
      buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
      sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
    } catch (err) {
      console.log("⚠️ Pre-price query failed — aborting trade:", err.message);
      return;
    }
    // implied prices (USDC per token)
    const buyPrice  = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    let expectedProfitUSDC = sellPrice - buyPrice;

    // apply slippage guard
    expectedProfitUSDC *= (1 - SLIPPAGE_PCT/100);

    console.log(`📈 Quoted: buyPrice=${fmt(buyPrice,6)} | sellPrice=${fmt(sellPrice,6)} | expectedProfit=${fmt(expectedProfitUSDC,6)} USDC (after ${SLIPPAGE_PCT}% slippage)`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      console.log(`❌ PREVENTED — Expected profit ${fmt(expectedProfitUSDC)} <= MIN_EXPECTED_PROFIT ${MIN_EXPECTED_PROFIT}`);
      return;
    }

    // 4) Quick liquidity/price sanity: tiny outputs are suspicious
    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) || !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed — possible illiquid pair — aborting");
      return;
    }

    // 5) Conservative gas check: estimate gas and compare to GAS_EST_USDC threshold
    let gasEstimate = null;
    let gasPrice = null;
    try {
      // estimate gas for the contract call (do not send)
      gasEstimate = await arbContract.estimateGas.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6)
      );
      const feeData = await provider.getFeeData();
      gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits("1", "gwei"); // fallback
      const gasCostNative = Number(gasEstimate) * Number(gasPrice);
      console.log(`⛽️ EstGas: ${gasEstimate.toString()} • gasPrice: ${gasPrice.toString()} • est gas native units: ${gasCostNative}`);
      // We can't reliably convert native -> USDC without oracles; we still use GAS_EST_USDC as a conservative threshold
      if (expectedProfitUSDC <= GAS_EST_USDC) {
        console.log(`❌ PREVENTED — expectedProfit ${fmt(expectedProfitUSDC)} ≤ GAS_EST_USDC ${GAS_EST_USDC} (conservative)`);
        return;
      }
    } catch (e) {
      console.warn("⚠️ Gas estimate failed — continuing but be cautious:", e.message);
      // we do not auto-abort here, but we could if desired
    }

    // 6) Option 6: provider.call() simulation of executeArbitrage to detect revert without sending tx
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData(
          "executeArbitrage",
          [buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6)]
        ),
        from: wallet ? wallet.address : undefined
      });
      console.log("🔬 Simulation OK — executeArbitrage callStatic passed");
    } catch (simErr) {
      console.log("❌ SIMULATION FAILED — Contract would revert:", simErr.message.split("\n")[0]);
      console.log("❌ Trade aborted — vault remains unchanged");
      return;
    }

    // 7) At this point, the trade appears viable — emit and (optionally) execute
    console.log(`💥 PROFITABLE SIGNAL — expected net profit (est) ${fmt(expectedProfitUSDC)} USDC`);
    if (DRY_RUN) {
      console.log("🧪 DRY_RUN: would execute, but not sending tx (stopping here).");
      return;
    }

    // 8) Execute transaction
    console.log("🚀 Executing arbitrage (on-chain) — sending tx...");
    let tx;
    try {
      tx = await arbContract.executeArbitrage(
        buyRouter,
        sellRouter,
        tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6),
        { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined } // small buffer if gasEstimate present
      );
    } catch (sendErr) {
      console.error("❌ Failed to send tx:", sendErr.message);
      return;
    }

    if (!tx || !tx.hash) {
      console.error("❌ Tx did not return a hash — aborting post-checks. Vault unchanged.");
      return;
    }
    console.log(`🔁 TX SENT — hash: ${tx.hash} — waiting for confirmation...`);

    // 9) Wait for receipt + verify status
    const receipt = await tx.wait();
    if (!receipt || (!('status' in receipt) ? false : receipt.status === 0)) {
      console.log("❌ Transaction reverted or failed on-chain — vault unchanged");
      return;
    }
    console.log(`✅ Transaction success — txHash ${receipt.transactionHash} • gasUsed ${receipt.gasUsed?.toString() || "n/a"}`);

    // 10) After-trade vault balance verification (Option 5)
    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    console.log(`🏦 Vault Balance After: ${fmt(after)} USDC`);

    if (after <= before) {
      console.log("❌ Trade resulted in no net vault increase — treated as failed/ignored (Option 5)");
      return;
    }

    // 11) Real net profit (+ logging)
    const netProfit = after - before;
    console.log(`💰 REAL Net Profit This Trade: ${fmt(netProfit)} USDC`);
    cumulativeProfit += netProfit;
    console.log(`📊 Cumulative Profit: ${fmt(cumulativeProfit)} USDC`);

    // 12) Persist the trade to CSV
    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({
      timestamp,
      symbol,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profitUSDC: netProfit
    });
    console.log("🗂 Trade logged to CSV buffer");

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01); // default small
async function scanOnce() {
  console.log("\n🔍 Scanning for arbitrage opportunities...");
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
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          let profitPct = (profitUSDC / buyPrice) * 100;

          console.log(`${symbol} | ${buyName} → ${sellName} | buy=${fmt(buyPrice)} sell=${fmt(sellPrice)} | profit=${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 PROFITABLE: ${symbol} | ${buyName} → ${sellName} | est ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);
            opportunities.push({ symbol, tokenAddr: token.address, buyRouter, sellRouter, buyName, sellName, profitUSDC });
            // execute with internal checks in executeTradeLive
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn(`⚠️ Scan error for ${symbol} ${buyName}->${sellName}:`, e.message);
        }
      }
    }
  }

  saveCSV();
  console.log(`🔍 Scan complete — found ${opportunities.length} candidate opportunities.`);
  return opportunities;
}

// ---------- MAIN ----------
(async function main(){
  await init();
  console.log("🚀 Improved arbitrage runner started");
  // single scan for safety here; adapt loop as needed
  try {
    await scanOnce();
  } catch (e) {
    console.error("Fatal scanner error:", e.message);
  }
})();
