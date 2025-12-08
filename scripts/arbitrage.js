// improved-arbitrage.js
// Full fixed arbitrage runner
// - Correct DRY_RUN logic
// - Proper round-trip math (USDC -> token -> USDC)
// - Gas cost estimated and converted to USDC
// - CSV logging + cumulative profit
// Requires: ethers v6, dotenv

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const CLI_ARGS = process.argv.slice(2);
const CLI_LIVE = CLI_ARGS.includes("--live") || CLI_ARGS.includes("-l");

// DRY_RUN logic:
// If DRY_RUN is set in .env, only "true" turns it on. If absent, default to true (safe).
const ENV_DRY = process.env.DRY_RUN;
const DRY_RUN = CLI_LIVE ? false : (typeof ENV_DRY === "string" ? (ENV_DRY === "true") : true);

console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trading config
const MIN_PROFIT_PCT      = Number(process.env.MIN_PROFIT_PCT || 20);      // percent threshold to attempt
const MIN_TRADE_USDC      = Number(process.env.MIN_TRADE_USDC || 0.5);    // default trade size in USDC
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.001);
const SLIPPAGE_PCT        = Number(process.env.SLIPPAGE_PCT || 0.0);
const MAX_PROFIT_PCT      = Number(process.env.MAX_PROFIT_PCT || 40);

// Routers (Polygon)
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Token map and decimals
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// WMATIC (Polygon) — used to compute gas cost in USDC
const WMATIC = { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 };

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, cumulative, note = "" }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, cumulative, note].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","CumulativeProfitUSDC","Note"];
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
  { "inputs": [], "name":"owner", "outputs":[{ "internalType":"address","name":"","type":"address" }], "stateMutability":"view", "type":"function" }
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

// ---------- Price helpers ----------
// Generic getAmountsOut wrapper
async function routerGetAmountsOut(routerAddr, amountsIn, path) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  return await router.getAmountsOut(amountsIn, path);
}

// Return token quantity when swapping amountUSDC on router: USDC -> token
async function getTokenAmountFromUSDC(routerAddr, token, amountUSDC, usdcAddr) {
  const usdcAddress = usdcAddr;
  const pathDirect = [usdcAddress, token.address];
  try {
    const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(amountUSDC.toString(), 6), pathDirect);
    // amounts[1] is token amount (or last element if multi-hop)
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch (err) {
    // fallback via WMATIC
    try {
      const fallback = [usdcAddress, WMATIC.address, token.address];
      const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(amountUSDC.toString(), 6), fallback);
      return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
    } catch (e) {
      throw new Error("getTokenAmountFromUSDC failed: " + e.message);
    }
  }
}

// Return USDC amount when swapping tokenAmount on router: token -> USDC
async function getUSDCFromToken(routerAddr, token, tokenAmount, usdcAddr) {
  const pathDirect = [token.address, usdcAddr];
  try {
    const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(tokenAmount.toString(), token.decimals), pathDirect);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
  } catch (err) {
    try {
      const fallback = [token.address, WMATIC.address, usdcAddr];
      const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(tokenAmount.toString(), token.decimals), fallback);
      return Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
    } catch (e) {
      throw new Error("getUSDCFromToken failed: " + e.message);
    }
  }
}

// Compute how much USDC equals `nativeAmount` of WMATIC using router (any router works)
async function getUSDCValueOfMatic(routerAddr, maticAmount) {
  // convert maticAmount (in native units, i.e., MATIC) to USDC amount
  const usdcAddress = await arbContract.USDC();
  try {
    const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(maticAmount.toString(), WMATIC.decimals), [WMATIC.address, usdcAddress]);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
  } catch (e) {
    // fallback: return a large number to be conservative (prevents execution)
    console.warn("⚠️ Could not convert MATIC -> USDC for gas cost:", e.message);
    return Number.POSITIVE_INFINITY;
  }
}

async function estimateGasCostInUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  // estimate gas using contract. Then compute gas * effectiveGasPrice (wei) -> MATIC -> convert to USDC.
  try {
    const gasEstimate = await arbContract.estimateGas.executeArbitrage(
      buyRouter, sellRouter, tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6)
    );
    // get current fee data
    const feeData = await provider.getFeeData();
    // choose effective gas price (maxFeePerGas if available else gasPrice)
    const effectiveGasPrice = feeData.maxFeePerGas || feeData.gasPrice;
    // gasCost in wei (native)
    const gasCostNativeWei = gasEstimate * effectiveGasPrice;
    // convert wei to native (MATIC)
    const gasCostNative = Number(ethers.formatUnits(gasCostNativeWei, 18)); // MATIC
    // convert MATIC to USDC using quickswap router
    // use QuickSwap by default; if fails, return Infinity to block trade
    const quick = routers.QuickSwap;
    const gasCostUSDC = await getUSDCValueOfMatic(quick, gasCostNative);
    return { gasEstimate, gasCostNative, gasCostUSDC };
  } catch (e) {
    console.warn("⚠️ Gas estimate failed:", e.message);
    return { gasEstimate: null, gasCostNative: null, gasCostUSDC: Number.POSITIVE_INFINITY };
  }
}

// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    // Read vault before (if possible)
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

    // Compute round-trip: USDC -> token (buyRouter) -> USDC (sellRouter)
    const usdcAddress = await arbContract.USDC();
    let tokenOut;
    try {
      tokenOut = await getTokenAmountFromUSDC(buyRouter, tokenObj, amountUSDC, usdcAddress);
    } catch (err) {
      console.log("⚠️ Pre-price query failed (buy side) — aborting trade:", err.message);
      return;
    }

    let usdcReturned;
    try {
      usdcReturned = await getUSDCFromToken(sellRouter, tokenObj, tokenOut, usdcAddress);
    } catch (err) {
      console.log("⚠️ Pre-price query failed (sell side) — aborting trade:", err.message);
      return;
    }

    let expectedProfitUSDC = (usdcReturned - amountUSDC) * (1 - SLIPPAGE_PCT / 100);
    const expectedProfitPct = (expectedProfitUSDC / amountUSDC) * 100;

    if (!Number.isFinite(expectedProfitUSDC)) {
      console.log("⚠️ Expected profit invalid — aborting");
      return;
    }
    if (expectedProfitPct > MAX_PROFIT_PCT) {
      console.log(`⚠️ Skipping — profit ${fmt(expectedProfitPct)}% exceeds ${MAX_PROFIT_PCT}% cap`);
      return;
    }

    console.log(`📈 Quoted round-trip: tokenOut=${fmt(tokenOut,6)} token | returned=${fmt(usdcReturned,6)} USDC | expectedProfit=${fmt(expectedProfitUSDC)} USDC | expectedPct=${fmt(expectedProfitPct)}%`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      console.log("❌ PREVENTED — Not enough expected profit");
      return;
    }

    // quick sanity checks
    if (!(await priceSanityCheck(buyRouter, tokenObj, amountUSDC)) || !(await priceSanityCheck(sellRouter, tokenObj, tokenOut))) {
      console.log("⚠️ Price sanity check failed");
      return;
    }

    // Estimate gas cost in USDC and compare
    const { gasEstimate, gasCostNative, gasCostUSDC } = await estimateGasCostInUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC);
    if (gasCostUSDC === Number.POSITIVE_INFINITY) {
      console.log("⚠️ Could not determine gas cost in USDC; aborting for safety");
      return;
    }

    console.log(`⛽ Gas estimate: ${gasEstimate ? gasEstimate.toString() : "n/a"} • ≈ ${fmt(gasCostNative,6)} MATIC • ≈ ${fmt(gasCostUSDC,6)} USDC`);

    const profitAfterGas = expectedProfitUSDC - gasCostUSDC;
    if (profitAfterGas <= MIN_EXPECTED_PROFIT) {
      console.log(`❌ PREVENTED — expected profit after estimated gas (${fmt(profitAfterGas)} USDC) is too low`);
      return;
    }

    // Simulation
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
      console.log("❌ SIM FAILED — would revert:", simErr.message);
      return;
    }

    // Dry-run early return (but record quoted expectation for analysis)
    if (DRY_RUN) {
      console.log("🧪 DRY RUN — not sending tx");
      logTradeCSV({ timestamp, symbol: getSymbol(tokenAddr), buyRouter, sellRouter, amount: amountUSDC, profitUSDC: expectedProfitUSDC, cumulative: cumulativeProfit, note: "DRY_RUN" });
      return;
    }

    // Live: send tx (with gasLimit safety)
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

    // Read after balance
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

    // Log to CSV
    logTradeCSV({ timestamp, symbol: getSymbol(tokenAddr), buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, cumulative: cumulativeProfit });

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || MIN_TRADE_USDC);

async function priceSanityCheck(routerAddr, token, amountUSDCOrToken) {
  try {
    // if amountUSDCOrToken is in USDC (6 decimals) we'll call getTokenAmountFromUSDC; else call getUSDCFromToken
    const usdcAddress = await arbContract.USDC();
    if (amountUSDCOrToken <= 1000000) { // crude: small numbers treated as USDC
      const tokenOut = await getTokenAmountFromUSDC(routerAddr, token, amountUSDCOrToken, usdcAddress);
      return tokenOut > 0 && Number.isFinite(tokenOut);
    } else {
      const usdcReturn = await getUSDCFromToken(routerAddr, token, amountUSDCOrToken, usdcAddress);
      return usdcReturn > 0 && Number.isFinite(usdcReturn);
    }
  } catch (e) {
    return false;
  }
}

async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          // Pre-filter: inexpensive round-trip compute (same logic as executor but here used to log quickly)
          const usdcAddress = await arbContract.USDC();
          const tokenOut = await getTokenAmountFromUSDC(buyRouter, token, TRADE_AMOUNT_USDC, usdcAddress);
          const usdcReturned = await getUSDCFromToken(sellRouter, token, tokenOut, usdcAddress);
          let profitUSDC = (usdcReturned - TRADE_AMOUNT_USDC) * (1 - SLIPPAGE_PCT / 100);
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

  console.log(`📊 CUMULATIVE PROFIT SO FAR: ${fmt(cumulativeProfit)} USDC`);
  saveCSV();
}

function getSymbol(tokenAddr) {
  const entry = Object.entries(tokens).find(([k, t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
  return entry ? entry[0] : tokenAddr;
}

// ---------- MAIN ----------
(async function main(){
  await init();
  console.log("🚀 Improved arbitrage runner started");
  console.log(`Scanning every 10s — TRADE_AMOUNT_USDC=${TRADE_AMOUNT_USDC} • MIN_TRADE_USDC=${MIN_TRADE_USDC}`);

  // initial check to ensure USDC contract loaded
  if (!usdcContract) {
    console.warn("⚠️ USDC contract not available — script may not be able to compute prices or balances.");
  }

  // Continuous scanning
  setInterval(async () => {
    try {
      await scanAllPairs();
    } catch (e) {
      console.error("Fatal scanner error:", e.message);
    }
  }, 10000);
})();
