// scripts/arbitrage.js
// Vault-only arbitrage runner (ethers v6)
// Uses staticCall simulation first, then executes the real tx only if safe.
// Defaults tuned for a proof-of-increase run.

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com/";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const DRY_RUN = process.env.DRY_RUN === "true" || false;

// Safety / tuning (defaults tuned for proof run)
const GAS_COST_USDC = Number(process.env.GAS_COST_USDC ?? "0.5");     // conservative gas buffer (USDC)
const MIN_PROFIT_USDC = Number(process.env.MIN_PROFIT_USDC ?? "1");   // require at least 1 USDC profit before execution
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? "0.25");  // minimal percent profit (0.25%)
const MAX_PROFIT_PCT = Number(process.env.MAX_PROFIT_PCT ?? "400");
const MAX_PRICE_MULTIPLIER = Number(process.env.MAX_PRICE_MULTIPLIER ?? "1000");

// Addresses (your contract + common tokens)
const CONTRACT_ADDRESS_RAW = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS_RAW = process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";

// DEX Routers (default set)
const DEX_ROUTERS = {
  QuickSwap: process.env.QUICK_ROUTER || "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: process.env.SUSHI_ROUTER || "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: process.env.APESWAP_ROUTER || "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Scan settings (default TRADE_AMOUNT_USDC set to 50 for an observable profit run)
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC ?? "50");
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT ?? "0.5"); // 0.5% slippage
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
let CONTRACT_ADDRESS, USDC_ADDRESS;
try { CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW); } catch { CONTRACT_ADDRESS = CONTRACT_ADDRESS_RAW.toLowerCase(); }
try { USDC_ADDRESS = ethers.getAddress(USDC_ADDRESS_RAW); } catch { USDC_ADDRESS = USDC_ADDRESS_RAW.toLowerCase(); }

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

async function getAmountOut(routerAddr, tokenObj, amountInUSDC) {
  try {
    if (!routerAddr || !tokenObj || !tokenObj.address) return 0;
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amountInWei = ethers.parseUnits(amountInUSDC.toString(), 6);
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
    console.log("❌ executeArbitrage missing — abort.");
    return;
  }

  // ensure owner & signer are same
  try {
    const owner = await arbContract.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`❌ Wallet (${wallet.address}) is not owner (${owner}). Abort.`);
      return;
    }
  } catch (e) {
    console.warn("⚠ Could not fetch owner:", e?.message || e);
    return;
  }

  // read contract on-chain minProfit (USDC)
  let contractMinProfitRaw = 0;
  try {
    const mp = await arbContract.minProfit();
    contractMinProfitRaw = Number(ethers.formatUnits(mp, 6));
  } catch {
    console.warn("⚠ Couldn't read contract.minProfit — assuming 0.");
    contractMinProfitRaw = 0;
  }

  // read vault before trade (for logging; final check occurs on-chain)
  const beforeBalRaw = await getVaultBalance();
  console.log(`🏦 Vault Before Trade: ${fmt(beforeBalRaw)} USDC`);

  const amountInWei = ethers.parseUnits(amountUSDC.toString(), 6);

  // 1) static simulation (callStatic) - MUST PASS
  try {
    // If executeArbitrage returns a value on-chain, staticCall may return it. If not, it simply must not revert.
    // Using previous pattern: arbContract.executeArbitrage.staticCall(...)
    await arbContract.executeArbitrage.staticCall(buyRouter, sellRouter, tokenAddr, amountInWei);
    console.log("✅ static simulation passed");
  } catch (simErr) {
    console.log("❌ static simulation failed — abort:", simErr?.message || simErr);
    return;
  }

  // 2) DEX quote simulation (off-chain sanity check)
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr };
  const buyOutTokens = await getAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOutTokens = await getAmountOut(sellRouter, tokenObj, amountUSDC);

  if (buyOutTokens === 0 || sellOutTokens === 0) {
    console.log("❌ Missing or zero DEX quotes — abort.");
    return;
  }

  const buyPrice = amountUSDC / buyOutTokens;
  const sellPrice = amountUSDC / sellOutTokens;
  const tokenAmount = buyOutTokens;
  const rawProfitUSDC = (sellPrice - buyPrice) * tokenAmount;
  const profitPct = (buyPrice > 0) ? (((sellPrice - buyPrice) / buyPrice) * 100) : 0;
  const adjustedProfitUSDC = rawProfitUSDC * (1 - SLIPPAGE_PCT / 100);
  const adjustedProfitPct = profitPct * (1 - SLIPPAGE_PCT / 100);

  console.log(`Simulated prices: buy ${fmt(buyPrice,6)} sell ${fmt(sellPrice,6)} => est profit ${fmt(adjustedProfitUSDC,6)} USDC (${fmt(adjustedProfitPct,2)}%)`);

  if (!isReasonablePrice(buyPrice, sellPrice)) {
    console.log("❌ Unreasonable price delta — abort.");
    return;
  }
  if (!isReasonableProfit(adjustedProfitUSDC, adjustedProfitPct)) {
    console.log(`❌ Profit ${fmt(adjustedProfitUSDC)} USDC (${fmt(adjustedProfitPct,2)}%) below threshold — abort.`);
    return;
  }

  // 3) estimateGas (robust fallback)
  let estimatedGas;
  try {
    if (arbContract.estimateGas && arbContract.estimateGas.executeArbitrage) {
      estimatedGas = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei);
    } else {
      const data = arbContract.interface.encodeFunctionData("executeArbitrage", [buyRouter, sellRouter, tokenAddr, amountInWei]);
      estimatedGas = await provider.estimateGas({
        to: CONTRACT_ADDRESS,
        data
      });
    }
  } catch (gErr) {
    console.log("❌ estimateGas failed — abort:", gErr?.message || gErr);
    return;
  }

  const gasLimit = (typeof estimatedGas === "bigint" ? (estimatedGas + 10000n) : (BigInt(estimatedGas) + 10000n));
  console.log(`⛽ Gas estimate (with buffer): ${gasLimit.toString()}`);

  // native balance check for wallet (owner must have MATIC)
  try {
    const balNative = await provider.getBalance(wallet.address);
    if (balNative <= 0n) {
      console.log("❌ Owner wallet native balance is 0 — fund MATIC to send tx. Abort.");
      return;
    }
  } catch (e) {
    console.warn("⚠ Could not fetch native balance:", e?.message || e);
  }

  // required profit check: must exceed gas buffer + contract minimum + MIN_PROFIT_USDC
  const requiredProfitBuffer = GAS_COST_USDC + contractMinProfitRaw + MIN_PROFIT_USDC;
  if (adjustedProfitUSDC < requiredProfitBuffer) {
    console.log(`❌ Adjusted profit ${fmt(adjustedProfitUSDC)} USDC < required buffer ${fmt(requiredProfitBuffer)} USDC — abort.`);
    return;
  }

  if (DRY_RUN) {
    console.log("🔬 DRY_RUN enabled — skipping real execution (would have executed).");
    logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profit: fmt(adjustedProfitUSDC,6) });
    return;
  }

  // 4) SEND TX
  try {
    console.log("📤 Sending executeArbitrage tx...");
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei, { gasLimit });
    console.log("📤 txHash:", tx.hash);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ Transaction reverted on-chain.");
      return;
    }
    console.log("✅ Transaction confirmed:", receipt.transactionHash);

    // 5) read vault after trade
    const afterBalRaw = await getVaultBalance();
    console.log(`🏦 Vault After Trade: ${fmt(afterBalRaw)} USDC`);
    const netProfit = afterBalRaw - beforeBalRaw;
    const pctGain = (beforeBalRaw > 0) ? (netProfit / beforeBalRaw * 100) : (netProfit * 1000);
    console.log(`💰 Net Profit: ${fmt(netProfit)} USDC (+${fmt(pctGain,2)}%)`);

    logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profit: fmt(netProfit,6) });

  } catch (err) {
    console.error("⚠ Error executing trade:", err?.message || err);
  }
}

// ===== SCAN LOOP =====
let isScanning = false;
async function scan() {
  if (isScanning) return;
  isScanning = true;

  console.log("🔍 Scanning for arbitrage opportunities...\n");
  try {
    for (const [symbol, token] of Object.entries(tokens)) {
      if (!token || !token.address) continue;
      for (const [buyName, buyRouter] of Object.entries(DEX_ROUTERS)) {
        for (const [sellName, sellRouter] of Object.entries(DEX_ROUTERS)) {
          if (buyName === sellName) continue;
          try {
            const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
            const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
            if (buyOut === 0 || sellOut === 0) continue;

            const buyPrice = TRADE_AMOUNT_USDC / buyOut;
            const sellPrice = TRADE_AMOUNT_USDC / sellOut;
            const rawProfit = (sellPrice - buyPrice) * buyOut;
            const profitPct = (buyPrice > 0) ? (((sellPrice - buyPrice) / buyPrice) * 100) : 0;
            const adjustedProfit = rawProfit * (1 - SLIPPAGE_PCT / 100);

            console.log(`${symbol} | ${buyName} $${fmt(buyPrice,6)} → ${sellName} $${fmt(sellPrice,6)} | Est. Profit: ${fmt(adjustedProfit,6)} USDC (${fmt(profitPct,2)}%)`);

            if (adjustedProfit >= MIN_PROFIT_USDC && profitPct >= MIN_PROFIT_PCT) {
              await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
            }
          } catch (err) {
            console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}:`, (err && err.message) ? err.message : err);
          }
        }
      }
    }
  } finally {
    isScanning = false;
  }
}

// ===== MAIN LOOP & SIGNALS =====
let stopping = false;
process.on("SIGINT", () => { console.log("\n🛑 SIGINT received — exiting gracefully"); stopping = true; });
process.on("SIGTERM", () => { console.log("\n🛑 SIGTERM received — exiting gracefully"); stopping = true; });

async function main() {
  console.log("🚀 Starting vault-only arb scanner (staticCall first)");
  console.log("🏛 Vault Contract:", CONTRACT_ADDRESS);

  try {
    const owner = await arbContract.owner();
    console.log("👤 Owner:", owner);
  } catch (e) {
    console.warn("⚠ Could not fetch owner:", e?.message || e);
  }

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
