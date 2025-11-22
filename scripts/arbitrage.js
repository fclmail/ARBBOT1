// scripts/arbitrage.js
// Vault-only arbitrage runner (ethers v6)
// Verbose logging: shows buy/sell DEX, prices, static call pass, execution, vault before/after, net profit.
// Default proof-run settings: TRADE_AMOUNT_USDC = 0.02

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com/";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const DRY_RUN = process.env.DRY_RUN === "true" || false;

// Safety / tuning (tuned for small proof run)
const GAS_COST_USDC = Number(process.env.GAS_COST_USDC ?? "0.0004");   // estimate gas expressed in USDC units
const MIN_PROFIT_USDC = Number(process.env.MIN_PROFIT_USDC ?? "0.00001"); // tiny absolute profit to allow very small tests
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? "0.01");   // 0.01% minimal percent profit
const MAX_PROFIT_PCT = Number(process.env.MAX_PROFIT_PCT ?? "400");
const MAX_PRICE_MULTIPLIER = Number(process.env.MAX_PRICE_MULTIPLIER ?? "1000");

// Addresses (set CONTRACT_ADDRESS in .env to override)
const CONTRACT_ADDRESS_RAW = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS_RAW = process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";

// DEX Routers (default set)
const DEX_ROUTERS = {
  QuickSwap: process.env.QUICK_ROUTER || "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: process.env.SUSHI_ROUTER || "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: process.env.APESWAP_ROUTER || "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Scan settings (YOU REQUESTED trade amount 0.02)
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC ?? "0.02");
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT ?? "0.5"); // 0.5% slippage default
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

// canonicalize addresses
let CONTRACT_ADDRESS, USDC_ADDRESS;
try { CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW); } catch { CONTRACT_ADDRESS = CONTRACT_ADDRESS_RAW.toLowerCase(); }
try { USDC_ADDRESS = ethers.getAddress(USDC_ADDRESS_RAW); } catch { USDC_ADDRESS = USDC_ADDRESS_RAW.toLowerCase(); }

// ===== CONTRACT INSTANCES =====
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);
let usdcContract = null;

// ===== TOKENS =====
// Keep this small list; add more tokens to your `tokens` object as needed.
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

  // make sure our signer is the owner
  try {
    const owner = await arbContract.owner();
    console.log(`👤 Contract owner on-chain: ${owner}`);
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`❌ Wallet (${wallet.address}) is not owner. Abort.`);
      return;
    }
  } catch (e) {
    console.warn("⚠ Could not fetch owner:", e?.message || e);
    return;
  }

  // read contract on-chain minProfit
  let contractMinProfitRaw = 0;
  try {
    const mp = await arbContract.minProfit();
    contractMinProfitRaw = Number(ethers.formatUnits(mp, 6));
  } catch {
    console.warn("⚠ Couldn't read contract.minProfit — assuming 0.");
    contractMinProfitRaw = 0;
  }

  // read vault before trade
  const beforeBalRaw = await getVaultBalance();
  console.log(`🏦 Vault Before Trade: ${fmt(beforeBalRaw)} USDC`);

  const amountInWei = ethers.parseUnits(amountUSDC.toString(), 6);

  // 1) static simulation (callStatic)
  console.log("🔬 Running callStatic simulation (on-chain dry-run)...");
  try {
    // prefer the staticCall form you use; this will run contract logic and must not revert
    await arbContract.executeArbitrage.staticCall(buyRouter, sellRouter, tokenAddr, amountInWei);
    console.log("✅ staticCall passed: contract simulation did NOT revert");
  } catch (simErr) {
    console.log("❌ staticCall reverted — aborting execution. Reason:", (simErr && (simErr.reason || simErr.message)) || simErr);
    return;
  }

  // 2) off-chain DEX quotes for sanity & profit estimate
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr };
  const buyOutTokens = await getAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOutTokens = await getAmountOut(sellRouter, tokenObj, amountUSDC);

  if (buyOutTokens === 0 || sellOutTokens === 0) {
    console.log("❌ DEX quote missing/zero — abort.");
    return;
  }

  const buyPrice = amountUSDC / buyOutTokens;
  const sellPrice = amountUSDC / sellOutTokens;
  const tokenAmount = buyOutTokens;
  const rawProfitUSDC = (sellPrice - buyPrice) * tokenAmount;
  const profitPct = (buyPrice > 0) ? (((sellPrice - buyPrice) / buyPrice) * 100) : 0;
  const adjustedProfitUSDC = rawProfitUSDC * (1 - SLIPPAGE_PCT / 100);
  const adjustedProfitPct = profitPct * (1 - SLIPPAGE_PCT / 100);

  console.log("🔎 DEX Quote Summary:");
  console.log(`   BUY  on ${getKeyByValue(DEX_ROUTERS, buyRouter)} @ ${fmt(buyPrice,6)} USDC per token -> tokenAmount ${fmt(tokenAmount,6)}`);
  console.log(`   SELL on ${getKeyByValue(DEX_ROUTERS, sellRouter)} @ ${fmt(sellPrice,6)} USDC per token`);
  console.log(`   Est raw profit: ${fmt(rawProfitUSDC,6)} USDC   (pct: ${fmt(profitPct,4)}%)`);
  console.log(`   Adjusted profit (slippage ${SLIPPAGE_PCT}%): ${fmt(adjustedProfitUSDC,6)} USDC   (pct: ${fmt(adjustedProfitPct,4)}%)`);

  if (!isReasonablePrice(buyPrice, sellPrice)) {
    console.log("❌ Unreasonable price delta between DEXes — abort.");
    return;
  }
  if (!isReasonableProfit(adjustedProfitUSDC, adjustedProfitPct)) {
    console.log(`❌ Off-chain profit check failed: ${fmt(adjustedProfitUSDC,6)} USDC (${fmt(adjustedProfitPct,4)}%) — abort.`);
    return;
  }

  // 3) estimateGas (robust fallback)
  let estimatedGas;
  try {
    if (arbContract.estimateGas && arbContract.estimateGas.executeArbitrage) {
      estimatedGas = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei);
    } else {
      const data = arbContract.interface.encodeFunctionData("executeArbitrage",[buyRouter, sellRouter, tokenAddr, amountInWei]);
      estimatedGas = await provider.estimateGas({ to: CONTRACT_ADDRESS, data });
    }
  } catch (gErr) {
    console.log("❌ estimateGas failed — abort:", gErr?.message || gErr);
    return;
  }
  const gasLimit = (typeof estimatedGas === "bigint" ? (estimatedGas + 10000n) : (BigInt(estimatedGas) + 10000n));
  console.log(`⛽ Gas estimate (with buffer): ${gasLimit.toString()}`);

  // wallet native balance check
  try {
    const nativeBal = await provider.getBalance(wallet.address);
    console.log(`⛽ Owner native balance: ${ethers.formatEther(nativeBal)} MATIC`);
    if (nativeBal <= 0n) {
      console.log("❌ Owner has insufficient native balance for gas — abort.");
      return;
    }
  } catch (e) {
    console.warn("⚠ Could not fetch wallet native balance:", e?.message || e);
  }

  // required profit buffer check
  const requiredProfitBuffer = GAS_COST_USDC + contractMinProfitRaw + MIN_PROFIT_USDC;
  console.log(`🔢 Required profit buffer (GAS + contractMin + MIN_PROFIT_USDC): ${fmt(requiredProfitBuffer)} USDC`);
  if (adjustedProfitUSDC < requiredProfitBuffer) {
    console.log(`❌ Adjusted profit ${fmt(adjustedProfitUSDC)} USDC < required buffer ${fmt(requiredProfitBuffer)} USDC — abort.`);
    return;
  }

  if (DRY_RUN) {
    console.log("🔬 DRY_RUN enabled — skipping real tx (would have executed).");
    logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profit: fmt(adjustedProfitUSDC,6) });
    return;
  }

  // 4) SEND executeArbitrage
  try {
    console.log("🚀 staticCall passed and off-chain checks OK — sending on-chain executeArbitrage...");
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei, { gasLimit });
    console.log("📤 txHash:", tx.hash);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ Transaction reverted or failed on-chain.");
      return;
    }
    console.log("✅ Transaction confirmed:", receipt.transactionHash);

    // 5) read vault after trade and compute net profit
    const afterBalRaw = await getVaultBalance();
    console.log(`🏦 Vault After Trade: ${fmt(afterBalRaw)} USDC`);
    const netProfit = afterBalRaw - beforeBalRaw;
    const pctGain = (beforeBalRaw > 0) ? (netProfit / beforeBalRaw * 100) : (netProfit * 1000);
    console.log(`💰 Net Profit (on-chain): ${fmt(netProfit)} USDC   (+${fmt(pctGain,4)}%)`);

    // Emit CSV log
    logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter: getKeyByValue(DEX_ROUTERS, buyRouter), sellRouter: getKeyByValue(DEX_ROUTERS, sellRouter), amount: amountUSDC, profit: fmt(netProfit,6) });

  } catch (err) {
    console.error("⚠ Error executing trade:", (err && (err.reason || err.message)) || err);
  }
}

// helper to find key by value in DEX_ROUTERS
function getKeyByValue(obj, val) {
  for (const k of Object.keys(obj)) {
    if (obj[k].toLowerCase() === (val || "").toLowerCase()) return k;
  }
  return String(val).slice(0,12);
}

// ===== SCAN LOOP =====
let isScanning = false;
async function scan() {
  if (isScanning) return;
  isScanning = true;

  console.log("🔍 Scanning for arbitrage opportunities (verbose) ...\n");
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

            // verbose scan output
            console.log(`→ ${symbol} | BUY:${buyName} @ ${fmt(buyPrice,6)} → SELL:${sellName} @ ${fmt(sellPrice,6)} | EstProfit: ${fmt(adjustedProfit,6)} USDC (${fmt(profitPct,4)}%)`);

            // decision: if off-chain adjustedProfit >= MIN_PROFIT_USDC and profitPct >= MIN_PROFIT_PCT => try execute trade
            if (adjustedProfit >= MIN_PROFIT_USDC && profitPct >= MIN_PROFIT_PCT) {
              console.log(`   Candidate qualifies for executeAttempt: amount ${TRADE_AMOUNT_USDC} USDC, estProfit ${fmt(adjustedProfit,6)} USDC`);
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
  console.log("🚀 Starting vault-only verbose arb scanner (staticCall first)");
  console.log("🏛 Vault Contract:", CONTRACT_ADDRESS);
  console.log(`🔧 Settings: TRADE_AMOUNT_USDC=${TRADE_AMOUNT_USDC}, MIN_PROFIT_USDC=${MIN_PROFIT_USDC}, MIN_PROFIT_PCT=${MIN_PROFIT_PCT}, SLIPPAGE_PCT=${SLIPPAGE_PCT}`);

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
