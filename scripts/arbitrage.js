// scripts/arbitrage.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIGURATION =====
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com/";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env (load from .env or env)");
const DRY_RUN = false; // set true to prevent on-chain txs

// Vault / USDC addresses
const CONTRACT_ADDRESS_RAW = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS_RAW = "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";

// DEX routers
const DEX_ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Trade settings
const TRADE_AMOUNT_USDC = 10;     // amount in USDC to attempt per trade
const MIN_PROFIT_USDC = 0.001;    // minimum rawProfit (USDC) to consider executing
const MIN_PROFIT_PCT = 0.001;     // min percent profit (for scan filter)
const SLIPPAGE_PCT = 0.2;         // used in scanning price adjustments
const SCAN_DELAY_MS = 5000;       // loop delay (5s)

// ===== ABIs (minimal / as used) =====
const arbAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)"
];
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

// ===== PROVIDER & WALLET =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// canonicalize/validate addresses (avoid checksum errors)
let CONTRACT_ADDRESS, USDC_ADDRESS;
try {
  CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW);
} catch (e) {
  console.warn("⚠️ CONTRACT_ADDRESS checksum invalid — attempting lowercase fallback");
  CONTRACT_ADDRESS = CONTRACT_ADDRESS_RAW.toLowerCase();
}
try {
  USDC_ADDRESS = ethers.getAddress(USDC_ADDRESS_RAW);
} catch (e) {
  console.warn("⚠️ USDC_ADDRESS checksum invalid — attempting lowercase fallback");
  USDC_ADDRESS = USDC_ADDRESS_RAW.toLowerCase();
}

// ===== CONTRACT INSTANCES =====
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);
let usdcContract = null; // init later after reading USDC from contract (safer)

// ===== TOKENS TO SCAN =====
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
    // ethers v6 returns number or bigint; coerce to Number
    return Number(d);
  } catch {
    return 18;
  }
}

// Robust getAmountsOut with decimal handling and fallbacks
async function getAmountOut(routerAddr, tokenObj, amountInUSDC) {
  try {
    if (!routerAddr) return 0;
    if (!tokenObj || !tokenObj.address) return 0;

    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amountInWei = ethers.parseUnits(amountInUSDC.toString(), 6); // USDC 6 decimals
    // Primary path USDC -> token
    const path = [USDC_ADDRESS, tokenObj.address];

    // guard: router may be invalid; catch exceptions
    let amounts;
    try {
      amounts = await router.getAmountsOut(amountInWei, path);
    } catch (err) {
      amounts = null;
    }

    if (amounts && amounts.length >= 2) {
      const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
      const tokenAmount = Number(ethers.formatUnits(amounts[1], decimals));
      if (!isFinite(tokenAmount) || tokenAmount <= 0) return 0;
      return tokenAmount;
    }

    // fallback: USDC -> WBTC -> token
    try {
      const fallbackPath = [USDC_ADDRESS, tokens.WBTC.address, tokenObj.address];
      const amountsFb = await router.getAmountsOut(amountInWei, fallbackPath);
      if (!amountsFb || amountsFb.length < 3) return 0;
      const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
      const tokenAmount = Number(ethers.formatUnits(amountsFb[2], decimals));
      if (!isFinite(tokenAmount) || tokenAmount <= 0) return 0;
      return tokenAmount;
    } catch (err2) {
      return 0;
    }
  } catch (errOuter) {
    // catch any unexpected runtime error and return 0 so scan keeps running
    return 0;
  }
}

// read vault USDC balance (in human USDC decimals)
async function getVaultBalance() {
  try {
    if (!usdcContract) {
      try {
        const addr = await arbContract.USDC();
        usdcContract = new ethers.Contract(addr || USDC_ADDRESS, erc20Abi, provider);
      } catch (e) {
        usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
      }
    }
    const bal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    return Number(ethers.formatUnits(bal, 6));
  } catch (e) {
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

// ===== EXECUTOR (keeps your original flow) =====
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();

  // guards
  if (!arbContract) {
    console.log("❌ arbContract undefined — aborting execution");
    return;
  }
  // function presence guard: ethers v6 method object may not have staticCall if ABI mismatched
  const hasExecute = !!arbContract.executeArbitrage;
  const hasStatic = hasExecute && (!!arbContract.executeArbitrage.staticCall || !!arbContract.executeArbitrage.staticcall);
  if (!hasExecute) {
    console.log("❌ executeArbitrage not present in contract ABI — aborting");
    return;
  }

  try {
    // vault before
    const beforeBalRaw = await getVaultBalance();
    console.log(`🏦 Vault Before Trade: ${fmt(beforeBalRaw)} USDC`);

    // ------------------ static simulation (no gas) ------------------
    const amountInWei = ethers.parseUnits(amountUSDC.toString(), 6);

    try {
      // Ethers v6: use .staticCall on the method to simulate
      if (arbContract.executeArbitrage.staticCall) {
        await arbContract.executeArbitrage.staticCall(buyRouter, sellRouter, tokenAddr, amountInWei);
      } else {
        // Fallback: attempt to call as read-only by provider (may revert)
        await provider.call(arbContract.interface.encodeFunctionData("executeArbitrage", [buyRouter, sellRouter, tokenAddr, amountInWei]), { to: CONTRACT_ADDRESS });
      }
      console.log("✅ static simulation passed (would not revert)");
    } catch (simErr) {
      console.log("❌ static simulation failed — abort trade:", simErr?.message || simErr);
      return;
    }

    // gas estimate (optional guard)
    try {
      const estimated = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei);
      // estimateGas in ethers v6 returns bigint — add buffer as bigint
      const gasLimit = (typeof estimated === "bigint") ? (estimated + 10000n) : (BigInt(estimated) + 10000n);
      console.log(`⛽ Gas estimate (approx): ${gasLimit.toString()}`);
    } catch (gErr) {
      console.log("⚠ estimateGas failed (continuing):", gErr?.message || gErr);
    }

    if (DRY_RUN) {
      console.log("🔬 DRY_RUN enabled — not sending real tx. Simulation only.");
      return;
    }

    // Execute real tx (signed by wallet) — include gasLimit guard
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei, { gasLimit: 900_000 });
    if (!tx || !tx.hash) {
      console.log("❌ Tx object invalid or tx.hash undefined — aborting");
      return;
    }
    console.log("📤 txHash:", tx.hash);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ Transaction reverted or failed on-chain — vault unchanged");
      return;
    }
    console.log("✅ Transaction confirmed:", receipt.transactionHash);

    // vault after
    const afterBalRaw = await getVaultBalance();
    console.log(`🏦 Vault After Trade: ${fmt(afterBalRaw)} USDC`);

    // verify vault increased
    const netProfit = afterBalRaw - beforeBalRaw;
    if (netProfit <= 0) {
      console.log("❌ Vault did not increase — treating as failed/ignored (no loss logged).");
      return;
    }
    console.log(`💰 Net Profit: ${fmt(netProfit)} USDC`);

    // log CSV entry
    const symEnt = Object.entries(tokens).find(([k,v]) => v.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symEnt ? symEnt[0] : tokenAddr;
    logTradeCSV({
      timestamp,
      symbol,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profit: fmt(netProfit, 6)
    });
  } catch (err) {
    console.error("⚠ Error in executeTradeLive:", err?.message || err);
  }
}

// ===== SCAN FUNCTION (original style preserved, hardened) =====
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
          // validate routers
          if (!buyRouter || !sellRouter) {
            console.warn(`⚠️ Router undefined for ${buyName} or ${sellName} — skipping`);
            continue;
          }

          // Obtain token amounts out for TRADE_AMOUNT_USDC on both routers
          const buyOutTokens = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOutTokens = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          // Skip routes with missing data
          if (buyOutTokens === 0 || sellOutTokens === 0) {
            continue;
          }

          // Compute implied prices: USDC per token = (amountInUSDC) / (tokenAmountOut)
          const buyPrice = TRADE_AMOUNT_USDC / buyOutTokens;
          const sellPrice = TRADE_AMOUNT_USDC / sellOutTokens;

          const tokenAmount = buyOutTokens; // units of token
          const rawProfitUSDC = (sellPrice - buyPrice) * tokenAmount;
          const profitPct = (buyPrice > 0) ? (((sellPrice - buyPrice) / buyPrice) * 100) : 0;

          // Apply slippage guard to reported numbers (conservative)
          const adjustedProfitUSDC = rawProfitUSDC * (1 - SLIPPAGE_PCT / 100);
          const adjustedProfitPct = profitPct * (1 - SLIPPAGE_PCT / 100);

          const buyPstr = isFinite(buyPrice) ? fmt(buyPrice,6) : "NaN";
          const sellPstr = isFinite(sellPrice) ? fmt(sellPrice,6) : "NaN";
          const profitStr = isFinite(adjustedProfitUSDC) ? fmt(adjustedProfitUSDC,6) : "NaN";
          const pctStr = isFinite(adjustedProfitPct) ? fmt(adjustedProfitPct,2) : "NaN";

          console.log(`${symbol} | ${buyName} $${buyPstr} → ${sellName} $${sellPstr} | Est. Profit: ${profitStr} USDC (${pctStr}%)`);

          // filters (min absolute and percent)
          if (adjustedProfitUSDC >= MIN_PROFIT_USDC || adjustedProfitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ symbol, buyName, sellName, buyRouter, sellRouter });
            console.log(`🚨 PROFITABLE: executing ${symbol} ${buyName}→${sellName}`);
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (err) {
          // scanning errors should not crash the bot
          console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}:`, (err && err.message) ? err.message : err);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Opportunities found: ${opportunities.length}\n`);
  saveCSV();
  return opportunities;
}

// ===== MAIN LOOP =====
let stopping = false;
process.on("SIGINT", () => {
  console.log("\n🛑 Caught SIGINT — saving CSV and exiting gracefully...");
  stopping = true;
});
process.on("SIGTERM", () => {
  console.log("\n🛑 Caught SIGTERM — saving CSV and exiting gracefully...");
  stopping = true;
});

async function main() {
  console.log("🚀 LIVE MODE ENABLED — ORIGINAL ARCHITECTURE (hardening applied)");
  console.log("🏛 Vault Contract:", CONTRACT_ADDRESS);

  try {
    const owner = await arbContract.owner();
    console.log("👤 Owner:", owner);
  } catch (e) {
    console.warn("⚠ Could not fetch vault owner (continuing):", e?.message || e);
  }

  // warm up usdcContract
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr || USDC_ADDRESS, erc20Abi, provider);
  } catch (e) {
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

    // sleep
    await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
  }

  // shutdown actions
  saveCSV();
  console.log("👋 Exiting.");
}

// start
main().catch(err => {
  console.error("Fatal error in arbitrage script:", err && err.stack ? err.stack : err);
  saveCSV();
  process.exit(1);
});

