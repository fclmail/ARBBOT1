// scripts/arbitrage.js
// Strong-safety arbitrage runner (ethers v6)
// MIN_PROFIT_PCT is set to 5 (%) as requested.

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com/";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const DRY_RUN = process.env.DRY_RUN === "true" || false;

// Safety / tuning
const GAS_COST_USDC = Number(process.env.GAS_COST_USDC ?? "0.15"); // conservative USDC buffer for gas & slippage
const MIN_PROFIT_USDC = Number(process.env.MIN_PROFIT_USDC ?? "0.0000001"); // absolute floor (human USDC)
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? "0.0001"); // percent (user requested 5%)
const MAX_PROFIT_PCT = Number(process.env.MAX_PROFIT_PCT ?? "400"); // reject absurd profit% > 400%
const MAX_PRICE_MULTIPLIER = Number(process.env.MAX_PRICE_MULTIPLIER ?? "1000");

// Addresses (provided)
const CONTRACT_ADDRESS_RAW = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS_RAW = "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";
const AAVE_POOL_RAW = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

// Routers to scan
const DEX_ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Scan settings
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC ?? "524"); // human USDC
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT ?? "0.01"); // percent slippage to be conservative
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS ?? "5000");

// ===== ABIs =====
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
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

// ===== PROVIDER & WALLET =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// canonicalize/validate addresses
let CONTRACT_ADDRESS, USDC_ADDRESS, AAVE_POOL;
try { CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW); } catch { CONTRACT_ADDRESS = CONTRACT_ADDRESS_RAW.toLowerCase(); }
try { USDC_ADDRESS = ethers.getAddress(USDC_ADDRESS_RAW); } catch { USDC_ADDRESS = USDC_ADDRESS_RAW.toLowerCase(); }
try { AAVE_POOL = ethers.getAddress(AAVE_POOL_RAW); } catch { AAVE_POOL = AAVE_POOL_RAW.toLowerCase(); }

// ===== CONTRACT INSTANCES =====
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);
let usdcContract = null;

// ===== TOKENS =====
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ===== UTILITIES =====
function fmt(n, dec = 6) {
  if (n === null || typeof n === "undefined" || Number.isNaN(Number(n))) return "NaN";
  return Number(n).toFixed(dec);
}

async function safeGetDecimals(tokenAddr) {
  try {
    const t = new ethers.Contract(tokenAddr, erc20Abi, provider);
    const d = await t.decimals();
    return Number(d);
  } catch {
    return 18;
  }
}

// fetch DEX quote safely with fallback
async function getAmountOut(routerAddr, tokenObj, amountInUSDC) {
  try {
    if (!routerAddr || !tokenObj || !tokenObj.address) return 0;
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amountInWei = ethers.parseUnits(amountInUSDC.toString(), 6); // USDC 6 decimals

    const primaryPath = [USDC_ADDRESS, tokenObj.address];
    let amounts = null;
    try { amounts = await router.getAmountsOut(amountInWei, primaryPath); } catch { amounts = null; }

    if (amounts && amounts.length >= 2) {
      const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
      const tokenAmount = Number(ethers.formatUnits(amounts[1], decimals));
      if (!isFinite(tokenAmount) || tokenAmount <= 0) return 0;
      return tokenAmount;
    }

    // fallback via WBTC
    try {
      const fallback = [USDC_ADDRESS, tokens.WBTC.address, tokenObj.address];
      const amountsFb = await router.getAmountsOut(amountInWei, fallback);
      if (!amountsFb || amountsFb.length < 3) return 0;
      const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
      const tokenAmount = Number(ethers.formatUnits(amountsFb[2], decimals));
      if (!isFinite(tokenAmount) || tokenAmount <= 0) return 0;
      return tokenAmount;
    } catch {
      return 0;
    }
  } catch {
    return 0;
  }
}

// read vault USDC balance (human)
async function getVaultBalance() {
  try {
    if (!usdcContract) {
      try {
        const addr = await arbContract.USDC();
        usdcContract = new ethers.Contract(addr || USDC_ADDRESS, erc20Abi, provider);
      } catch {
        usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
      }
    }
    const bal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    return Number(ethers.formatUnits(bal, 6));
  } catch {
    return 0;
  }
}

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profit].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const csvContent = [header.join(","), ...csvRows].join("\n");
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, csvContent);
  console.log(`💾 Trades exported to CSV: ${filename}`);
}

// ===== SAFETY HELPERS =====
function isReasonableProfit(profitUSDC, profitPct) {
  if (!isFinite(profitUSDC) || !isFinite(profitPct)) return false;
  if (profitUSDC <= 0) return false;
  if (profitPct <= 0) return false;
  if (profitPct > MAX_PROFIT_PCT) return false;
  if (profitPct < MIN_PROFIT_PCT) return false;
  return true;
}

function isReasonablePrice(buyPrice, sellPrice) {
  if (!isFinite(buyPrice) || !isFinite(sellPrice)) return false;
  const multiplier = Math.max(buyPrice / (sellPrice || 1), sellPrice / (buyPrice || 1));
  if (!isFinite(multiplier) || multiplier > MAX_PRICE_MULTIPLIER) return false;
  return true;
}

// ===== EXECUTOR (strict checks) =====
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();

  if (!arbContract || typeof arbContract.executeArbitrage !== "function") {
    console.log("❌ executeArbitrage missing in contract ABI or contract undefined — abort.");
    return;
  }

  // read contract minProfit (assumed USDC 6-decimals)
  let contractMinProfitRaw = 0;
  try {
    const mp = await arbContract.minProfit();
    contractMinProfitRaw = Number(ethers.formatUnits(mp, 6));
  } catch (e) {
    console.log("❌ Couldn't read contract.minProfit — abort for safety.");
    return;
  }

  // vault before
  const beforeBalRaw = await getVaultBalance();
  console.log(`🏦 Vault Before Trade: ${fmt(beforeBalRaw)} USDC`);

  const amountInWei = ethers.parseUnits(amountUSDC.toString(), 6);

  // 1) static simulation MUST pass
  try {
    await arbContract.executeArbitrage.staticCall(buyRouter, sellRouter, tokenAddr, amountInWei);
    console.log("✅ static simulation passed (no on-chain revert)");
  } catch (simErr) {
    console.log("❌ static simulation failed — abort:", simErr?.message || simErr);
    return;
  }

  // 2) DEX quote simulation: buy then sell (local estimate)
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr };
  const buyOutTokens = await getAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOutTokens = await getAmountOut(sellRouter, tokenObj, amountUSDC);

  if (buyOutTokens === 0 || sellOutTokens === 0) {
    console.log("❌ Missing or zero DEX quotes — abort.");
    return;
  }

  // compute implied USDC-per-token prices approximated for this trade amount
  const buyPrice = TRADE_AMOUNT_USDC / buyOutTokens;
  const sellPrice = TRADE_AMOUNT_USDC / sellOutTokens;
  const tokenAmount = buyOutTokens;
  const rawProfitUSDC = (sellPrice - buyPrice) * tokenAmount;
  const profitPct = (buyPrice > 0) ? (((sellPrice - buyPrice) / buyPrice) * 100) : 0;
  const adjustedProfitUSDC = rawProfitUSDC * (1 - SLIPPAGE_PCT / 100);
  const adjustedProfitPct = profitPct * (1 - SLIPPAGE_PCT / 100);

  console.log(`Simulated prices: buy ${fmt(buyPrice,6)} sell ${fmt(sellPrice,6)} => est profit ${fmt(adjustedProfitUSDC,6)} USDC (${fmt(adjustedProfitPct,2)}%)`);

  // sanity checks
  if (!isReasonablePrice(buyPrice, sellPrice)) {
    console.log("❌ Unreasonable price delta detected — abort.");
    return;
  }
  if (!isReasonableProfit(adjustedProfitUSDC, adjustedProfitPct)) {
    console.log(`❌ Profit ${fmt(adjustedProfitUSDC)} USDC (${fmt(adjustedProfitPct,2)}%) does not meet thresholds -> abort.`);
    return;
  }

  // 3) estimateGas MUST succeed
  let estimatedGas;
  try {
    estimatedGas = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei);
  } catch (gErr) {
    console.log("❌ estimateGas failed — abort for safety:", gErr?.message || gErr);
    return;
  }

  // add buffer to gas (bigint safe)
  let gasLimit = typeof estimatedGas === "bigint" ? (estimatedGas + 10000n) : (BigInt(estimatedGas) + 10000n);
  console.log(`⛽ Gas estimate (with buffer): ${gasLimit.toString()}`);

  // required profit buffer includes: on-contract minProfit + conservative GAS_COST_USDC + MIN_PROFIT_USDC
  const requiredProfitBuffer = GAS_COST_USDC + contractMinProfitRaw + MIN_PROFIT_USDC;
  if (adjustedProfitUSDC < requiredProfitBuffer) {
    console.log(`❌ Adjusted profit ${fmt(adjustedProfitUSDC)} USDC < required buffer ${fmt(requiredProfitBuffer)} USDC — abort.`);
    return;
  }

  // DRY_RUN guard
  if (DRY_RUN) {
    console.log("🔬 DRY_RUN enabled — not sending tx. Trade considered PASS under dry-run.");
    logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profit: fmt(adjustedProfitUSDC,6) });
    return;
  }

  // 4) Execute real tx
  try {
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei, { gasLimit });
    if (!tx || !tx.hash) {
      console.log("❌ Tx object invalid — abort.");
      return;
    }
    console.log("📤 txHash:", tx.hash);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ Transaction reverted on-chain — vault unchanged.");
      return;
    }
    console.log("✅ Transaction confirmed:", receipt.transactionHash);

    // vault after
    const afterBalRaw = await getVaultBalance();
    console.log(`🏦 Vault After Trade: ${fmt(afterBalRaw)} USDC`);
    const netProfit = afterBalRaw - beforeBalRaw;
    if (netProfit <= 0) {
      console.log("❌ Vault did not increase (or decreased). Marking as fail and NOT logging profit.");
      return;
    }
    const pctGain = (beforeBalRaw > 0) ? (netProfit / beforeBalRaw * 100) : (netProfit * 1000); // fallback pct if tiny vault
    if (pctGain < MIN_PROFIT_PCT && netProfit < MIN_PROFIT_USDC) {
      console.log(`❌ On-chain profit ${fmt(netProfit)} USDC (${fmt(pctGain,2)}%) below required thresholds — ignoring.`);
      return;
    }
    console.log(`💰 Net Profit (on-chain): ${fmt(netProfit)} USDC (+${fmt(pctGain,2)}%)`);
    logTradeCSV({
      timestamp,
      symbol: Object.keys(tokens).find(k => tokens[k].address.toLowerCase() === tokenAddr.toLowerCase()) || tokenAddr,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profit: fmt(netProfit, 6)
    });
  } catch (err) {
    console.error("⚠ Error executing trade:", err?.message || err);
  }
}

// ===== SCAN LOOP =====
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...\n");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    if (!token || !token.address) {
      console.warn(`⚠️ Token entry invalid for ${symbol} — skipping`);
      continue;
    }
    for (const [buyName, buyRouter] of Object.entries(DEX_ROUTERS)) {
      for (const [sellName, sellRouter] of Object.entries(DEX_ROUTERS)) {
        if (buyName === sellName) continue;
        try {
          if (!buyRouter || !sellRouter) continue;

          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          if (buyOut === 0 || sellOut === 0) continue;

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          const rawProfit = (sellPrice - buyPrice) * buyOut;
          const profitPct = (buyPrice > 0) ? (((sellPrice - buyPrice) / buyPrice) * 100) : 0;
          const adjustedProfit = rawProfit * (1 - SLIPPAGE_PCT / 100);

          console.log(`${symbol} | ${buyName} $${fmt(buyPrice,6)} → ${sellName} $${fmt(sellPrice,6)} | Est. Profit: ${fmt(adjustedProfit,6)} USDC (${fmt(profitPct,2)}%)`);

          // preliminary filter: requires positive and reasonable profit
          if (adjustedProfit >= MIN_PROFIT_USDC && profitPct >= MIN_PROFIT_PCT && adjustedProfit < 1e6) {
            console.log(`🚨 Candidate: ${symbol} ${buyName}→${sellName} est ${fmt(adjustedProfit,6)}USDC (${fmt(profitPct,2)}%)`);
            opportunities.push({ symbol, buyName, sellName, buyRouter, sellRouter, tokenAddress: token.address, estProfit: adjustedProfit, estPct: profitPct });
            // perform strict checks inside executor (staticCall + estimateGas + on-contract minProfit)
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (err) {
          console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}:`, (err && err.message) ? err.message : err);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Opportunities found: ${opportunities.length}\n`);
  saveCSV();
  return opportunities;
}

// ===== MAIN LOOP & SIGNALS =====
let stopping = false;
process.on("SIGINT", () => { console.log("\n🛑 SIGINT received — exiting gracefully"); stopping = true; });
process.on("SIGTERM", () => { console.log("\n🛑 SIGTERM received — exiting gracefully"); stopping = true; });

async function main() {
  console.log("🚀 Starting arb scanner (safe mode)");
  console.log("🏛 Vault Contract:", CONTRACT_ADDRESS);

  try {
    const owner = await arbContract.owner();
    console.log("👤 Owner:", owner);
  } catch (e) {
    console.warn("⚠ Could not fetch owner:", e?.message || e);
  }

  // warm up usdcContract
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr || USDC_ADDRESS, erc20Abi, provider);
  } catch {
    usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  }

  let loop = 0;
  while (!stopping) {
    loop++;
    console.log(`\n🔁 Scan loop #${loop} — ${new Date().toISOString()}`);
    try {
      await scan();
    } catch (err) {
      console.error("⚠️ Fatal scan error (loop will continue):", err?.message || err);
    }
    await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
  }

  saveCSV();
  console.log("👋 Exiting.");
}

main().catch(err => {
  console.error("Fatal error:", err && err.stack ? err.stack : err);
  saveCSV();
  process.exit(1);
});
