// scripts/arbitrage.js
// Vault-only arbitrage runner (ethers v6)
// Verbose logging, staticCall first, robust estimateGas fallback.
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
const GAS_COST_USDC = Number(process.env.GAS_COST_USDC ?? "0.0004");   // estimate gas in USDC units
const MIN_PROFIT_USDC = Number(process.env.MIN_PROFIT_USDC ?? "0.00001"); // tiny absolute profit to allow small tests
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? "0.01");   // 0.01% minimal percent profit
const MAX_PROFIT_PCT = Number(process.env.MAX_PROFIT_PCT ?? "400");
const MAX_PRICE_MULTIPLIER = Number(process.env.MAX_PRICE_MULTIPLIER ?? "1000");

// Addresses (set in .env to override)
const CONTRACT_ADDRESS_RAW = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS_RAW = process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";

// DEX Routers (defaults)
const DEX_ROUTERS = {
  QuickSwap: process.env.QUICK_ROUTER || "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: process.env.SUSHI_ROUTER || "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: process.env.APESWAP_ROUTER || "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Scan settings (proof-run uses trade amount 0.02)
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC ?? "0.02");
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT ?? "0.5"); // percent
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
  "function symbol() view returns (string)",
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

// token metadata cache
const tokenMeta = {}; // tokenAddress -> {decimals, symbol}

// ===== UTILITIES =====
function nowISO() { return new Date().toISOString(); }

function safeNumber(n, dec = 6) {
  if (n === null || typeof n === "undefined" || Number.isNaN(Number(n))) return "NaN";
  return Number(n).toFixed(dec);
}

async function getTokenContract(addr) {
  return new ethers.Contract(addr, erc20Abi, provider);
}

async function getTokenDecimals(addr) {
  addr = ethers.getAddress(addr);
  if (tokenMeta[addr] && tokenMeta[addr].decimals !== undefined) return tokenMeta[addr].decimals;
  try {
    const t = await getTokenContract(addr);
    const d = await t.decimals();
    tokenMeta[addr] = tokenMeta[addr] || {};
    tokenMeta[addr].decimals = Number(d);
    return Number(d);
  } catch {
    tokenMeta[addr] = tokenMeta[addr] || {};
    tokenMeta[addr].decimals = 18;
    return 18;
  }
}

async function getTokenSymbol(addr) {
  addr = ethers.getAddress(addr);
  if (tokenMeta[addr] && tokenMeta[addr].symbol) return tokenMeta[addr].symbol;
  try {
    const t = await getTokenContract(addr);
    const s = await t.symbol();
    tokenMeta[addr] = tokenMeta[addr] || {};
    tokenMeta[addr].symbol = s;
    return s;
  } catch {
    tokenMeta[addr] = tokenMeta[addr] || {};
    tokenMeta[addr].symbol = addr.slice(0,8);
    return tokenMeta[addr].symbol;
  }
}

async function formatTokenAmount(addr, raw) {
  const d = await getTokenDecimals(addr);
  return safeNumber(Number(ethers.formatUnits(raw, d)), 6);
}

async function getAmountOut(routerAddr, path, amountInUnits, amountInDecimals = 6) {
  try {
    if (!routerAddr || !path || path.length < 2) return null;
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amountInWei = ethers.parseUnits(amountInUnits.toString(), amountInDecimals);
    const amounts = await router.getAmountsOut(amountInWei, path);
    // amounts array of bigints
    return amounts; // caller will format
  } catch {
    return null;
  }
}

async function getVaultBalance() {
  try {
    if (!usdcContract) {
      try {
        const usdcAddr = await arbContract.USDC();
        usdcContract = new ethers.Contract(usdcAddr || USDC_ADDRESS, erc20Abi, provider);
      } catch {
        usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
      }
    }
    const bal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const dec = await getTokenDecimals(await usdcContract.address);
    return Number(ethers.formatUnits(bal, dec));
  } catch (e) {
    console.warn("getVaultBalance error:", e?.message || e);
    return 0;
  }
}

const csvRows = [];
function logTradeCSV({ timestamp, tokenSymbol, buyDex, sellDex, amountUSDC, estProfitUSDC, netProfitUSDC, txHash }) {
  csvRows.push([timestamp, tokenSymbol, buyDex, sellDex, amountUSDC, estProfitUSDC, netProfitUSDC, txHash].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyDEX","SellDEX","AmountUSDC","EstProfitUSDC","NetProfitUSDC","TxHash"];
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

function getKeyByValue(obj, val) {
  for (const k of Object.keys(obj)) {
    try {
      if (obj[k].toLowerCase() === (val || "").toLowerCase()) return k;
    } catch { }
  }
  return String(val).slice(0,12);
}

// ===== EXECUTOR (strict checks + verbose logging) =====
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = nowISO();
  if (!arbContract || typeof arbContract.executeArbitrage !== "function") {
    console.log("❌ executeArbitrage missing — abort.");
    return;
  }

  // ensure owner & signer match
  try {
    const owner = await arbContract.owner();
    console.log(`👤 Contract owner (on-chain): ${owner}`);
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`❌ Wallet (${wallet.address}) is not owner (${owner}). Abort.`);
      return;
    }
  } catch (e) {
    console.warn("⚠ Could not fetch owner:", e?.message || e);
    return;
  }

  // read contract minProfit
  let contractMinProfitRaw = 0;
  try {
    const mp = await arbContract.minProfit();
    contractMinProfitRaw = Number(ethers.formatUnits(mp, 6));
  } catch {
    console.warn("⚠ Couldn't read contract.minProfit — assuming 0.");
    contractMinProfitRaw = 0;
  }

  // vault before
  const beforeBalRaw = await getVaultBalance();
  console.log(`\n🏦 Vault Before Trade: ${safeNumber(beforeBalRaw,6)} USDC`);

  const amountInWei = ethers.parseUnits(amountUSDC.toString(), 6);

  // 1) static simulation (callStatic)
  console.log("🔬 Running callStatic simulation (on-chain dry-run)...");
  try {
    // prefer the staticCall form used in your environment
    await arbContract.executeArbitrage.staticCall(buyRouter, sellRouter, tokenAddr, amountInWei);
    console.log("✅ staticCall passed: contract simulation did NOT revert");
  } catch (simErr) {
    console.log("❌ staticCall reverted — aborting execution. Reason:", (simErr && (simErr.reason || simErr.message)) || simErr);
    return;
  }

  // 2) off-chain DEX quotes for sanity & profit estimate
  const tokenDecimals = await getTokenDecimals(tokenAddr);
  const tokenSymbol = await getTokenSymbol(tokenAddr).catch(() => tokenAddr.slice(0,8));

  // get amounts out via routers (USDC->token) and (token->USDC)
  const buyAmounts = await getAmountOut(buyRouter, [USDC_ADDRESS, tokenAddr], amountUSDC, 6);
  const sellAmounts = await getAmountOut(sellRouter, [USDC_ADDRESS, tokenAddr], amountUSDC, 6);
  // Note: getAmountOut called symmetrical for estimate; we will compute buy and sell prices from those amounts

  if (!buyAmounts || !sellAmounts) {
    console.log("❌ Missing DEX quotes — abort.");
    return;
  }

  // buyAmounts: [amountInUSDC_wei, tokenOut_wei]
  const tokenOutOnBuy = buyAmounts[1];
  // to simulate selling that token amount on sellRouter, call getAmountsOut(tokenAmount, [token, USDC])
  const sellBack = await (async () => {
    try {
      const router = new ethers.Contract(sellRouter, routerAbi, provider);
      // token amount has tokenDecimals
      const tokenAmountWei = tokenOutOnBuy;
      const amountsSell = await router.getAmountsOut(tokenAmountWei, [tokenAddr, USDC_ADDRESS]);
      return amountsSell;
    } catch {
      return null;
    }
  })();

  if (!sellBack) {
    console.log("❌ Could not get sell-back quote for token amount — abort.");
    return;
  }

  // Interpret amounts
  const tokenAmount = Number(ethers.formatUnits(tokenOutOnBuy, tokenDecimals)); // token units received when buying
  const usdcBack = Number(ethers.formatUnits(sellBack[1], 6)); // USDC returned after selling tokenAmount
  const rawProfitUSDC = usdcBack - amountUSDC;
  const profitPct = (amountUSDC > 0) ? ((rawProfitUSDC / amountUSDC) * 100) : 0;
  const adjustedProfitUSDC = rawProfitUSDC * (1 - SLIPPAGE_PCT / 100);
  const adjustedProfitPct = profitPct * (1 - SLIPPAGE_PCT / 100);

  console.log("🔎 Off-chain quote summary:");
  console.log(`   Token: ${tokenSymbol} (${tokenAddr})`);
  console.log(`   BUY on ${getKeyByValue(DEX_ROUTERS, buyRouter)} -> token amount: ${safeNumber(tokenAmount,6)} ${tokenSymbol}`);
  console.log(`   SELL on ${getKeyByValue(DEX_ROUTERS, sellRouter)} -> USDC returned: ${safeNumber(usdcBack,6)} USDC`);
  console.log(`   Est raw profit: ${safeNumber(rawProfitUSDC,6)} USDC (${safeNumber(profitPct,4)}%)`);
  console.log(`   Adjusted (slippage ${SLIPPAGE_PCT}%): ${safeNumber(adjustedProfitUSDC,6)} USDC (${safeNumber(adjustedProfitPct,4)}%)`);

  if (!isReasonableProfit(adjustedProfitUSDC, adjustedProfitPct)) {
    console.log(`❌ Off-chain profit check failed: ${safeNumber(adjustedProfitUSDC,6)} USDC (${safeNumber(adjustedProfitPct,4)}%) — abort.`);
    return;
  }

  // 3) estimateGas (robust fallback)
  let estimatedGas;
  try {
    if (arbContract.estimateGas && arbContract.estimateGas.executeArbitrage) {
      estimatedGas = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei);
    } else {
      const data = arbContract.interface.encodeFunctionData("executeArbitrage", [buyRouter, sellRouter, tokenAddr, amountInWei]);
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

  // required profit buffer check (GAS_COST_USDC + contractMinProfit + MIN_PROFIT_USDC)
  const requiredProfitBuffer = GAS_COST_USDC + contractMinProfitRaw + MIN_PROFIT_USDC;
  console.log(`🔢 Required profit buffer (GAS + contractMin + MIN_PROFIT_USDC): ${safeNumber(requiredProfitBuffer,6)} USDC`);
  if (adjustedProfitUSDC < requiredProfitBuffer) {
    console.log(`❌ Adjusted profit ${safeNumber(adjustedProfitUSDC,6)} USDC < required buffer ${safeNumber(requiredProfitBuffer,6)} USDC — abort.`);
    return;
  }

  if (DRY_RUN) {
    console.log("🔬 DRY_RUN enabled — skipping real tx (would have executed).");
    logTradeCSV({
      timestamp,
      tokenSymbol,
      buyDex: getKeyByValue(DEX_ROUTERS, buyRouter),
      sellDex: getKeyByValue(DEX_ROUTERS, sellRouter),
      amountUSDC,
      estProfitUSDC: safeNumber(adjustedProfitUSDC,6),
      netProfitUSDC: "0.000000",
      txHash: "DRY_RUN"
    });
    return;
  }

  // 4) SEND executeArbitrage tx (only now)
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

    // try decode common events if the contract emits them
    try {
      for (const log of receipt.logs) {
        try {
          const parsed = arbContract.interface.parseLog(log);
          if (parsed && parsed.name) {
            console.log(`🔔 Event ${parsed.name}:`, parsed.args);
          }
        } catch { /* ignore non-matching logs */ }
      }
    } catch (e) {
      console.warn("⚠ Could not parse events:", e?.message || e);
    }

    // 5) read vault after and compute net profit
    const afterBalRaw = await getVaultBalance();
    console.log(`🏦 Vault After Trade: ${safeNumber(afterBalRaw,6)} USDC`);
    const netProfit = afterBalRaw - beforeBalRaw;
    const pctGain = (beforeBalRaw > 0) ? (netProfit / beforeBalRaw * 100) : (netProfit * 1000);
    console.log(`💰 Net Profit (on-chain): ${safeNumber(netProfit,6)} USDC   (+${safeNumber(pctGain,4)}%)`);

    logTradeCSV({
      timestamp,
      tokenSymbol,
      buyDex: getKeyByValue(DEX_ROUTERS, buyRouter),
      sellDex: getKeyByValue(DEX_ROUTERS, sellRouter),
      amountUSDC,
      estProfitUSDC: safeNumber(adjustedProfitUSDC,6),
      netProfitUSDC: safeNumber(netProfit,6),
      txHash: receipt.transactionHash
    });

  } catch (err) {
    console.error("⚠ Error executing trade:", (err && (err.reason || err.message)) || err);
  }
}

// ===== SCAN LOOP (verbose) =====
let isScanning = false;
async function scan() {
  if (isScanning) return;
  isScanning = true;

  console.log("\n🔍 Scanning for arbitrage opportunities (verbose) ...");
  try {
    // Get vault balance to determine trade size (user requested fixed trade amount 0.02 — use that)
    for (const [symbol, token] of Object.entries({
      AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
      CRV:  { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18 },
      LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
      WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
    })) {
      const tokenAddr = token.address;
      for (const [buyName, buyRouter] of Object.entries(DEX_ROUTERS)) {
        for (const [sellName, sellRouter] of Object.entries(DEX_ROUTERS)) {
          if (buyName === sellName) continue;
          try {
            const buyOutTokens = await getAmountOut(buyRouter, [USDC_ADDRESS, tokenAddr], TRADE_AMOUNT_USDC, 6);
            const sellOutTokens = await getAmountOut(sellRouter, [USDC_ADDRESS, tokenAddr], TRADE_AMOUNT_USDC, 6);
            if (!buyOutTokens || !sellOutTokens) continue;

            // simple price approx: USDC per token ~ amountInUSDC / tokenAmount
            const tokenDecimals = token.decimals ?? await getTokenDecimals(tokenAddr);
            const buyTokenAmount = Number(ethers.formatUnits(buyOutTokens[1], tokenDecimals));
            const sellTokenAmount = Number(ethers.formatUnits(sellOutTokens[1], tokenDecimals));
            if (buyTokenAmount <= 0 || sellTokenAmount <= 0) continue;

            const buyPrice = TRADE_AMOUNT_USDC / buyTokenAmount;
            const sellPrice = TRADE_AMOUNT_USDC / sellTokenAmount;
            const rawProfit = (sellPrice - buyPrice) * buyTokenAmount;
            const profitPct = (buyPrice > 0) ? (((sellPrice - buyPrice) / buyPrice) * 100) : 0;
            const adjustedProfit = rawProfit * (1 - SLIPPAGE_PCT / 100);

            console.log(`→ ${symbol} | BUY:${buyName} $${safeNumber(buyPrice,6)} → SELL:${sellName} $${safeNumber(sellPrice,6)} | EstProfit: ${safeNumber(adjustedProfit,6)} USDC (${safeNumber(profitPct,4)}%)`);

            if (adjustedProfit >= MIN_PROFIT_USDC && profitPct >= MIN_PROFIT_PCT) {
              console.log(`   Candidate qualifies — attempting execute: amount ${TRADE_AMOUNT_USDC} USDC, estProfit ${safeNumber(adjustedProfit,6)} USDC`);
              await executeTradeLive(buyRouter, sellRouter, tokenAddr, TRADE_AMOUNT_USDC);
            }
          } catch (err) {
            console.warn(`⚠ Scan error ${symbol} ${buyName}->${sellName}:`, (err && err.message) ? err.message : err);
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
