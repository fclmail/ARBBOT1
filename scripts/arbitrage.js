// FULL UPDATED ARBJS (PASTABLE) — FIXED

import dotenv from "dotenv";
dotenv.config();

import { ethers, Wallet } from "ethers";
import fs from "fs";

// ---------------- CONFIG ----------------
const DRY_RUN = false;
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_NET_PROFIT_USDC = Number(process.env.MIN_NET_PROFIT_USDC || "2");
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || "0.5");
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || "0.2");
const MAX_PRICE_DEVIATION_PCT = Number(process.env.MAX_PRICE_DEVIATION_PCT || "10");
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || "0.001");

const NATIVE_USD_PRICE = process.env.NATIVE_USD_PRICE ? Number(process.env.NATIVE_USD_PRICE) : null;
if (!NATIVE_USD_PRICE) console.warn("⚠️ NATIVE_USD_PRICE not set — gas checks disabled");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ---------- ABIs ----------
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

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint amount) returns (bool)"
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ---------- Routers & Tokens ----------
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

// ---------- State & CSV ----------
let cumulativeProfit = 0;
const csvRows = [];

function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profit].join(","));
}

function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const csvContent = [header.join(","), ...csvRows].join("
");
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, csvContent);
  console.log(`💾 Trades exported to CSV: ${filename}`);
}

// ---------- Helpers ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getUSDCContract() {
  const usdcAddr = await arbContract.USDC();
  return new ethers.Contract(usdcAddr, erc20Abi, provider);
}

async function getVaultBalanceUSDC() {
  const usdc = await getUSDCContract();
  const bal = await usdc.balanceOf(CONTRACT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function getAmountOut(routerAddr, token, amountInUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountInUSDC.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountInUSDC.toString(), 6),
      fallback
    );
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

function percent(a, b) {
  return Math.abs((a - b) / ((a + b) / 2)) * 100; // symmetric percentage
}

async function estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  if (!NATIVE_USD_PRICE) throw new Error("NATIVE_USD_PRICE not set — refusing to estimate gas cost safely");
  const contractWithSigner = arbContract.connect(wallet);
  const amount = ethers.parseUnits(amountUSDC.toString(), 6);
  const gasEstimate = await contractWithSigner.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, amount);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  if (!gasPrice) throw new Error("Could not determine gas price");
  const gasCostNative = Number(ethers.formatUnits(gasEstimate * gasPrice, 18));
  const gasCostUSD = gasCostNative * NATIVE_USD_PRICE;
  return { gasEstimate: gasEstimate.toString(), gasCostNative, gasCostUSD };
}

// ---------- Trade execution with failsafes ----------
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  console.log("💸 Preparing to execute live trade — applying failsafes...");

  // Vault before balance
  const vaultBefore = await getVaultBalanceUSDC();
  console.log(`🏦 Vault Before: ${fmt(vaultBefore,6)} USDC`);

  // Estimate gas cost
  let gasEstimateInfo;
  try {
    gasEstimateInfo = await estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC);
    console.log(`⛽ Estimated Gas Cost: $${fmt(gasEstimateInfo.gasCostUSD,6)} (gas estimate ${gasEstimateInfo.gasEstimate})`);
  } catch (err) {
    console.warn(`⚠️ Gas estimation failed or NATIVE_USD_PRICE missing: ${err.message}`);
    if (!DRY_RUN) {
      console.error("⛔ Blocking trade: cannot safely estimate gas cost in USD.");
      return;
    }
  }

  // callStatic pre-check
  try {
    const callStaticAmount = ethers.parseUnits(amountUSDC.toString(), 6);
    await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, callStaticAmount, { from: wallet.address });
    console.log("🧪 callStatic: SUCCESS — simulation indicates the trade will not revert");
  } catch (err) {
    console.warn("❌ callStatic failed — trade blocked BEFORE sending — ZERO gas spent", err.message);
    return;
  }

  // Recompute expected amounts (sanity)
  try {
    const buyOutTokens = await getAmountOut(buyRouter, { address: tokenAddr, decimals: 6 }, amountUSDC).catch(()=>null);
    const sellOutTokens = await getAmountOut(sellRouter, { address: tokenAddr, decimals: 6 }, amountUSDC).catch(()=>null);
    if (!buyOutTokens || !sellOutTokens) {
      console.warn("⚠️ Could not fetch live price for profit re-check — blocking trade");
      return;
    }
  } catch (err) {
    console.warn("⚠️ Error during profit re-check — blocking trade:", err.message);
    return;
  }

  if (DRY_RUN) {
    console.log("🔎 DRY_RUN enabled — not sending transaction");
    return;
  }

  let tx;
  try {
    tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6),
      { gasLimit: 1_000_000 }
    );
  } catch (err) {
    console.error("⚠️ Failed to send transaction:", err.message);
    return;
  }

  if (!tx || !tx.hash) {
    console.error("⛔ txHash undefined — aborting. Transaction object invalid.");
    return;
  }

  console.log(`📤 Broadcasting transaction... txHash: ${tx.hash}`);

  let receipt;
  try {
    receipt = await tx.wait();
  } catch (err) {
    console.error("❌ Transaction failed or reverted:", err.message);
    return;
  }

  if (!receipt || receipt.status !== 1) {
    console.error("❌ Trade reverted on-chain — status != 1 — no profit. Receipt:", receipt);
    return;
  }

  console.log(`✅ Trade Confirmed — status: ${receipt.status}`);
  console.log(`⛽ Gas Used: ${receipt.gasUsed.toString()}`);

  const vaultAfter = await getVaultBalanceUSDC();
  console.log(`🏦 Vault After: ${fmt(vaultAfter,6)} USDC`);

  if (vaultAfter <= vaultBefore) {
    console.error("⛔ ALERT — Vault decreased or did not increase after trade. Reverting record and investigating.");
    return;
  }

  const netProfit = vaultAfter - vaultBefore;
  cumulativeProfit += netProfit;

  console.log(`📈 Net Profit: +${fmt(netProfit,6)} USDC`);
  console.log(`💰 Cumulative Profit: ${fmt(cumulativeProfit,6)} USDC`);

  logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profit: netProfit });
}

// ---------- SCAN LOOP WITH PROTECTION ----------
async function scan() {
  console.log("
🔍 Scanning for arbitrage opportunities with full protection...");
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

          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          profitUSDC *= 1 - SLIPPAGE_PCT / 100;
          profitPct *= 1 - SLIPPAGE_PCT / 100;

          console.log(`${symbol} | ${buyName} $${fmt(buyPrice)} → ${sellName} $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          const priceDeviation = percent(buyPrice, sellPrice);
          if (priceDeviation > MAX_PRICE_DEVIATION_PCT) {
            console.log(`⚠ Price deviation = ${fmt(priceDeviation,2)}% (>${MAX_PRICE_DEVIATION_PCT}% limit) — Rejected`);
            continue;
          }

          if (profitPct < MIN_PROFIT_PCT) {
            console.log(`❌ Rejected — below minimum profit percent (${MIN_PROFIT_PCT}%)`);
            continue;
          }

          let gasCostUSD = 0;
          try {
            const gasInfo = await estimateGasCostUSDC(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
            gasCostUSD = gasInfo.gasCostUSD;
          } catch (err) {
            console.warn(`⚠️ Gas cost estimation failed: ${err.message} — blocking live trade unless DRY_RUN.`);
            if (!DRY_RUN) continue;
          }

          const netExpected = profitUSDC - gasCostUSD;
          console.log(`⛽ Estimated Gas Cost: $${fmt(gasCostUSD,6)} → Net Expected: $${fmt(netExpected,6)}`);

          if (netExpected < MIN_NET_PROFIT_USDC) {
            console.log(`❌ Rejected — net expected profit ${fmt(netExpected,6)} USDC < minimum ${MIN_NET_PROFIT_USDC} USDC`);
            continue;
          }

          opportunities.push({ symbol, buyName, sellName });
          console.log(`✅ Passing all checks — executing: ${symbol} | ${buyName} → ${sellName}`);

          await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
        } catch (err) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}:`, err.message);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.`);
  saveCSV();
  return opportunities;
}

// ---------- MAIN ----------
(async () => {
  console.log("🚀 Live Aave Flash Arbitrage Bot with VAULT protections started
");
  try {
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
  } catch (err) {
    console.warn("⚠️ Could not fetch contract owner:", err.message);
  }

  while (true) {
    try {
      await scan();
    } catch (err) {
      console.error("Fatal scan loop error:", err.message);
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
})();
