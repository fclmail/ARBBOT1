// improved-arbitrage.js
// Rewritten with fixes:
// - avoids FixedNumber / scientific notation parse errors
// - uses safe decimal -> integer conversion for parseUnits
// - prints quoted round-trip, gas estimate, and simulation result (even in DRY_RUN)
// - retains gas->USDC conversion, CSV logging, cumulative profit, --live flag

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const CLI_ARGS = process.argv.slice(2);
const CLI_LIVE = CLI_ARGS.includes("--live") || CLI_ARGS.includes("-l");

// DRY_RUN logic: .env DRY_RUN === "true" => dry. Absent => default true (safe). CLI --live forces live.
const ENV_DRY = process.env.DRY_RUN;
const DRY_RUN = CLI_LIVE ? false : (typeof ENV_DRY === "string" ? (ENV_DRY === "false") : true);

console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trading config
const MIN_PROFIT_PCT      = Number(process.env.MIN_PROFIT_PCT || 20);
const MIN_TRADE_USDC      = Number(process.env.MIN_TRADE_USDC || 0.5);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.001);
const SLIPPAGE_PCT        = Number(process.env.SLIPPAGE_PCT || 0.0);
const MAX_PROFIT_PCT      = Number(process.env.MAX_PROFIT_PCT || 40);

// Routers (Polygon)
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens + decimals
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// WMATIC (native) used to compute gas->USDC
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

// Provider and wallet
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
const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider) : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ERC20 helper for USDC
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

// ---------- Helper: safe decimal string for parseUnits ----------
// Converts a JS number (or numeric string) to a non-scientific decimal string
// with up to `decimals` fractional digits (no scientific notation).
function toDecimalString(value, decimals = 18) {
  // Accept numbers or strings that are decimal-like
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num)) throw new Error("toDecimalString: non-finite number");
  // Use toFixed with decimals to avoid scientific notation for tiny numbers
  // but trim trailing zeros to be concise (while leaving at least 1 zero after decimal when needed)
  const s = num.toFixed(decimals);
  // trim trailing zeros and trailing dot
  return s.indexOf('.') === -1 ? s : s.replace(/\.?0+$/, '');
}

// ---------- Router helpers ----------
async function routerGetAmountsOut(routerAddr, amountInWei, path) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  return await router.getAmountsOut(amountInWei, path);
}

// Returns token amount as a JS number for USDC -> token (amountUSDC is number)
async function getTokenAmountFromUSDC(routerAddr, token, amountUSDC, usdcAddr) {
  const amountUSDCStr = toDecimalString(amountUSDC, 6); // 6 decimals for USDC
  try {
    const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(amountUSDCStr, 6), [usdcAddr, token.address]);
    const out = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(out, token.decimals));
  } catch (err) {
    // fallback via WMATIC
    try {
      const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(amountUSDCStr, 6), [usdcAddr, WMATIC.address, token.address]);
      const out = amounts[amounts.length - 1];
      return Number(ethers.formatUnits(out, token.decimals));
    } catch (e) {
      throw new Error("getTokenAmountFromUSDC failed: " + e.message);
    }
  }
}

// Returns USDC amount as a JS number for token -> USDC (tokenAmount is number)
async function getUSDCFromToken(routerAddr, token, tokenAmount, usdcAddr) {
  // convert tokenAmount to decimal string with token.decimals places
  const tokenAmountStr = toDecimalString(tokenAmount, token.decimals);
  try {
    const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(tokenAmountStr, token.decimals), [token.address, usdcAddr]);
    const out = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(out, 6)); // USDC decimals
  } catch (err) {
    // fallback via WMATIC
    try {
      const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(tokenAmountStr, token.decimals), [token.address, WMATIC.address, usdcAddr]);
      const out = amounts[amounts.length - 1];
      return Number(ethers.formatUnits(out, 6));
    } catch (e) {
      throw new Error("getUSDCFromToken failed: " + e.message);
    }
  }
}

// Convert native MATIC amount (number) to USDC using a router (QuickSwap)
async function getUSDCValueOfMatic(routerAddr, maticAmount) {
  const maticAmountStr = toDecimalString(maticAmount, WMATIC.decimals);
  const usdcAddr = await arbContract.USDC();
  try {
    const amounts = await routerGetAmountsOut(routerAddr, ethers.parseUnits(maticAmountStr, WMATIC.decimals), [WMATIC.address, usdcAddr]);
    const out = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(out, 6));
  } catch (e) {
    console.warn("⚠️ Could not convert MATIC->USDC:", e.message);
    return Number.POSITIVE_INFINITY;
  }
}

// Estimate gas -> convert to USDC
async function estimateGasCostInUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  try {
    const gasEstimate = await arbContract.estimateGas.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(toDecimalString(amountUSDC,6), 6)
    );
    const feeData = await provider.getFeeData();
    const effectiveGasPrice = feeData.maxFeePerGas || feeData.gasPrice;
    const gasCostNativeWei = gasEstimate * effectiveGasPrice; // BigInt multiplication (works in ethers v6)
    const gasCostNative = Number(ethers.formatUnits(gasCostNativeWei, 18)); // MATIC
    const gasCostUSDC = await getUSDCValueOfMatic(routers.QuickSwap, gasCostNative);
    return { gasEstimate, gasCostNative, gasCostUSDC };
  } catch (e) {
    console.warn("⚠️ Gas estimate failed:", e.message);
    return { gasEstimate: null, gasCostNative: null, gasCostUSDC: Number.POSITIVE_INFINITY };
  }
}

// ---------- CORE EXECUTION ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    // before balance
    let before = 0;
    try {
      const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
      before = Number(ethers.formatUnits(beforeBal, 6));
      console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);
    } catch (e) {
      console.warn("⚠️ Could not read vault balance:", e.message);
    }

    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
      return;
    }

    // Round-trip quotes
    const usdcAddr = await arbContract.USDC();
    let tokenOut;
    try {
      tokenOut = await getTokenAmountFromUSDC(buyRouter, tokenObj, amountUSDC, usdcAddr);
    } catch (err) {
      console.log("⚠️ Pre-price query failed (buy side) — aborting trade:", err.message);
      return;
    }

    let usdcReturned;
    try {
      usdcReturned = await getUSDCFromToken(sellRouter, tokenObj, tokenOut, usdcAddr);
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

    // Print detailed quote info (this fixes your missing quoted round-trip)
    console.log("📈 QUOTED ROUND-TRIP:");
    console.log(`   USDC -> token (on buyRouter): tokenOut = ${tokenOut}`);
    console.log(`   token -> USDC (on sellRouter): returnedUSDC = ${fmt(usdcReturned, 6)} USDC`);
    console.log(`   expectedProfit = ${fmt(expectedProfitUSDC, 6)} USDC (${fmt(expectedProfitPct, 4)}%)`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      console.log("❌ PREVENTED — Not enough expected profit");
      return;
    }

    // sanity checks
    if (!(await priceSanityCheck(buyRouter, tokenObj, amountUSDC)) || !(await priceSanityCheck(sellRouter, tokenObj, tokenOut))) {
      console.log("⚠️ Price sanity check failed");
      return;
    }

    // Gas estimate + convert to USDC, and print
    const { gasEstimate, gasCostNative, gasCostUSDC } = await estimateGasCostInUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC);
    if (gasCostUSDC === Number.POSITIVE_INFINITY) {
      console.log("⚠️ Could not determine gas cost in USDC; aborting for safety");
      return;
    }
    console.log(`⛽ GAS ESTIMATE: gasLimit=${gasEstimate ? gasEstimate.toString() : "n/a"} • ≈ ${fmt(gasCostNative, 8)} MATIC • ≈ ${fmt(gasCostUSDC, 8)} USDC`);

    const profitAfterGas = expectedProfitUSDC - gasCostUSDC;
    console.log(`   profitAfterGas ≈ ${fmt(profitAfterGas, 6)} USDC`);
    if (profitAfterGas <= MIN_EXPECTED_PROFIT) {
      console.log(`❌ PREVENTED — expected profit after estimated gas (${fmt(profitAfterGas)} USDC) is too low`);
      return;
    }

    // Simulation (provider.call) - print result
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [
          buyRouter, sellRouter, tokenAddr,
          ethers.parseUnits(toDecimalString(amountUSDC, 6), 6),
        ]),
        from: CONTRACT_ADDRESS
      });
      console.log("🔬 SIMULATION OK — contract call would succeed");
    } catch (simErr) {
      console.log("❌ SIM FAILED — would revert:", simErr.message);
      return;
    }

    // If dry-run, stop here but we already printed quotes, gas, simulation
    if (DRY_RUN) {
      console.log("🧪 DRY RUN — not sending tx (quoted + gas + simulation above)");
      logTradeCSV({ timestamp, symbol: getSymbol(tokenAddr), buyRouter, sellRouter, amount: amountUSDC, profitUSDC: expectedProfitUSDC, cumulative: cumulativeProfit, note: "DRY_RUN" });
      return;
    }

    // Live: send tx
    let tx;
    try {
      tx = await arbContract.executeArbitrage(
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(toDecimalString(amountUSDC, 6), 6),
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

    // after balance + profit calculation
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

    logTradeCSV({ timestamp, symbol: getSymbol(tokenAddr), buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, cumulative: cumulativeProfit });

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || MIN_TRADE_USDC);

async function priceSanityCheck(routerAddr, token, amountUSDCOrToken) {
  try {
    const usdcAddress = await arbContract.USDC();
    // crude check: if value <= 1e6 treat as USDC amount (since USDC uses 6 decimals)
    if (typeof amountUSDCOrToken === "number" && amountUSDCOrToken <= 1000000) {
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
  const usdcAddress = await arbContract.USDC();
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          // Pre-filter: round-trip compute
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

  if (!usdcContract) {
    console.warn("⚠️ USDC contract not available — script may not be able to compute prices or balances.");
  }

  setInterval(async () => {
    try {
      await scanAllPairs();
    } catch (e) {
      console.error("Fatal scanner error:", e.message);
    }
  }, 10000);
})();
