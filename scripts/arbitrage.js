// improved-arbitrage.js
// Fixed: DRY_RUN logic, proper price math (USDC -> token -> USDC), larger default trade amount,
// improved simulation call, cumulative profit tracking, safer fallbacks and logging.

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
/**
 * DRY_RUN behavior:
 * - If process.env.DRY_RUN exists, it's true only when exactly "true".
 * - If absent, default to true (safe).
 */
const DRY_RUN = process.env.DRY_RUN ? process.env.DRY_RUN === "true" : true;
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trading config
const MIN_PROFIT_PCT      = Number(process.env.MIN_PROFIT_PCT || 20);      // Minimum profit percent to attempt
const MIN_TRADE_USDC      = Number(process.env.MIN_TRADE_USDC || 0.5);    // default 0.5 USDC (was 0.01)
const GAS_EST_USDC        = Number(process.env.GAS_EST_USDC || 0.002);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.001);
const SLIPPAGE_PCT        = Number(process.env.SLIPPAGE_PCT || 0.0);
const MAX_PROFIT_PCT      = 40; // cap

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, cumulative }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, cumulative].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","CumulativeProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// Provider + wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// Minimal vault ABI
const arbAbi = [
  {
    "inputs": [
      { "internalType":"address","name":"buyRouter","type":"address" },
      { "internalType":"address","name":"sellRouter","type":"address" },
      { "internalType":"address","name":"token","type":"address" },
      { "internalType":"uint256","name":"amountIn","type":"uint256" }
    ],
    "name":"executeArbitrage",
    "outputs": [],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  { "inputs": [], "name":"USDC", "outputs":[{ "internalType":"address","name":"","type":"address" }], "stateMutability":"view", "type":"function" },
  { "inputs": [], "name":"owner", "outputs":[{ "internalType":"address","name":"","type":"address" }], "stateMutability":"view", "type":"function" },
  { "inputs": [], "name":"minProfit", "outputs":[{ "internalType":"uint256","name":"","type":"uint256" }], "stateMutability":"view", "type":"function" }
];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
                            : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ERC20 helper
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
    console.log("💱 USDC Address:", usdcAddr);
  } catch (e) {
    console.warn("⚠️ Initialization warning:", e.message);
  }
}

function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

// ---------- Price helpers (proper round-trip math) ----------
/**
 * Return token amount received when swapping `amountUSDC` on router from USDC -> token
 */
async function getTokenAmountFromUSDC(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    // fallback via WBTC (if direct pair doesn't exist)
    try {
      const fallback = [usdcAddress, tokens.WBTC.address, token.address];
      const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), fallback);
      return Number(ethers.formatUnits(amounts[2], token.decimals));
    } catch (e) {
      throw new Error("getTokenAmountFromUSDC failed: " + e.message);
    }
  }
}

/**
 * Return USDC amount received when swapping `tokenAmount` on router from token -> USDC
 */
async function getUSDCFromToken(routerAddr, token, tokenAmount) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdcAddress = await arbContract.USDC();
  const path = [token.address, usdcAddress];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(tokenAmount.toString(), token.decimals), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
  } catch (err) {
    // fallback via WBTC
    try {
      const fallback = [token.address, tokens.WBTC.address, usdcAddress];
      const amounts = await router.getAmountsOut(ethers.parseUnits(tokenAmount.toString(), token.decimals), fallback);
      return Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
    } catch (e) {
      throw new Error("getUSDCFromToken failed: " + e.message);
    }
  }
}

// Simple liquidity sanity check
async function priceSanityCheck(routerAddr, token, amountUSDC) {
  try {
    const tokenOut = await getTokenAmountFromUSDC(routerAddr, token, amountUSDC);
    return tokenOut > 0 && Number.isFinite(tokenOut);
  } catch (e) {
    return false;
  }
}

// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase())
                   || { address: tokenAddr, decimals: 18 };

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    // Read vault before balance (if possible)
    let before = 0;
    try {
      const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
      before = Number(ethers.formatUnits(beforeBal, 6));
      console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);
    } catch (e) {
      console.warn("⚠️ Could not read vault USDC balance:", e.message);
    }

    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
      return;
    }

    // Compute expected round-trip: USDC -> token (on buyRouter) -> back to USDC (on sellRouter)
    let tokenOut;
    try {
      tokenOut = await getTokenAmountFromUSDC(buyRouter, tokenObj, amountUSDC);
    } catch (err) {
      console.log("⚠️ Pre-price query failed (buy side) — aborting trade:", err.message);
      return;
    }

    let usdcReturned;
    try {
      usdcReturned = await getUSDCFromToken(sellRouter, tokenObj, tokenOut);
    } catch (err) {
      console.log("⚠️ Pre-price query failed (sell side) — aborting trade:", err.message);
      return;
    }

    // expectedProfit in USDC
    let expectedProfitUSDC = (usdcReturned - amountUSDC) * (1 - SLIPPAGE_PCT / 100);
    const expectedProfitPct = (expectedProfitUSDC / amountUSDC) * 100;

    // Additional safety cap
    if (expectedProfitPct > MAX_PROFIT_PCT) {
      console.log(`⚠️ Skipping — profit ${fmt(expectedProfitPct)}% exceeds ${MAX_PROFIT_PCT}% cap`);
      return;
    }

    console.log(`📈 Quoted: USDC->Token=${fmt(tokenOut,6)} (token) | Token->USDC=${fmt(usdcReturned,6)} USDC | expectedProfit=${fmt(expectedProfitUSDC)} USDC | expectedPct=${fmt(expectedProfitPct)}%`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      console.log("❌ PREVENTED — Not enough expected profit");
      return;
    }

    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) || !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed");
      return;
    }

    // Gas estimate (best effort)
    let gasEstimate = null;
    try {
      gasEstimate = await arbContract.estimateGas.executeArbitrage(
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6)
      );
    } catch (e) {
      console.warn("⚠️ Gas estimate failed, continuing");
    }

    // Simulation (provider.call). Use CONTRACT_ADDRESS as `from` so contract-level view logic matches tx context.
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [
          buyRouter, sellRouter, tokenAddr,
          ethers.parseUnits(amountUSDC.toString(), 6),
        ]),
        from: CONTRACT_ADDRESS
      });
      console.log("🔬 Simulation OK");
    } catch (simErr) {
      console.log("❌ SIM FAILED — would revert");
      return;
    }

    // If dry-run, stop here (we simulated and succeeded)
    if (DRY_RUN) {
      console.log("🧪 DRY RUN — not sending tx");
      // still record quoted profit to CSV for analysis (but mark as dry)
      logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: expectedProfitUSDC, cumulative: cumulativeProfit });
      return;
    }

    // Live mode: send tx
    let tx;
    try {
      tx = await arbContract.executeArbitrage(
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6),
        { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined }
      );
    } catch (sendErr) {
      console.error("❌ Failed to send tx:", sendErr.message);
      return;
    }
    console.log(`🔁 TX SENT — ${tx.hash}`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ TX failed");
      return;
    }
    console.log(`✅ Transaction success — ${receipt.transactionHash}`);

    // Read vault after
    let after = before;
    try {
      const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
      after = Number(ethers.formatUnits(afterBal, 6));
      console.log(`🏦 Vault After: ${fmt(after)} USDC`);
    } catch (e) {
      console.warn("⚠️ Could not read vault USDC after tx:", e.message);
    }

    if (after <= before) {
      console.log("⚠️ No net profit — ignored");
      return;
    }

    const netProfit = after - before;
    console.log(`💰 REAL PROFIT: ${fmt(netProfit)} USDC`);
    cumulativeProfit += netProfit;

    // Log to CSV with symbol name if available
    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, cumulative: cumulativeProfit });

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || MIN_TRADE_USDC);

async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          // Proper round-trip calculation, inside executeTradeLive we re-run to avoid double-calls - but here we prefilter cheaply:
          const tokenOut = await getTokenAmountFromUSDC(buyRouter, token, TRADE_AMOUNT_USDC);
          const usdcReturned = await getUSDCFromToken(sellRouter, token, tokenOut);

          let profitUSDC = (usdcReturned - TRADE_AMOUNT_USDC) * (1 - SLIPPAGE_PCT/100);
          let profitPct = (profitUSDC / TRADE_AMOUNT_USDC) * 100;

          if (!Number.isFinite(profitUSDC)) continue;
          if (profitPct > MAX_PROFIT_PCT) continue;

          console.log(`${symbol} | ${buyName}→${sellName} | profit=${fmt(profitUSDC)} USDC | profitPct=${fmt(profitPct)}%`);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 PROFITABLE — executing`);
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`${symbol} | ${buyName}→${sellName} | scan error:`, e.message);
        }
      }
    }
  }

  // Log cumulative and export CSV after each full scan
  console.log(`📊 CUMULATIVE PROFIT SO FAR: ${fmt(cumulativeProfit)} USDC`);
  saveCSV();
}

// ---------- MAIN ----------
(async function main(){
  await init();
  console.log("🚀 Improved arbitrage runner started");

  // Continuous scanning every 10 seconds
  setInterval(async () => {
    try {
      await scanAllPairs();
    } catch (e) {
      console.error("Fatal scanner error:", e.message);
    }
  }, 10000);
})();
