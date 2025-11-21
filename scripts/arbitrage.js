// scripts/arbitrage.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIGURATION =====
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env (load from .env or env)");
const DRY_RUN = false; // set true to prevent on-chain txs

// Vault / USDC addresses (keep these as-is; we will validate/checksum them at runtime)
const CONTRACT_ADDRESS_RAW = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS_RAW = "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";

// DEX routers (unchanged)
const DEX_ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Trade settings (you asked to change min profit earlier — keep configurable)
const TRADE_AMOUNT_USDC = 10;     // amount in USDC to attempt per trade
const MIN_PROFIT_USDC = 0.001;    // minimum rawProfit (USDC) to consider executing
const MIN_PROFIT_PCT = 0.001;     // min percent profit (for scan filter) - small to show more opps
const SLIPPAGE_PCT = 0.2;         // used in scanning price adjustments
const SCAN_DELAY_MS = 5000;       // loop delay (5s)

// ===== ABIs (minimal / as used) =====
const arbAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  // we will use callStatic on executeArbitrage: contract.callStatic.executeArbitrage(...)
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  // swapExactTokensForTokens not called from this script; contract handles swaps
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
// Keep tokens exactly as you had them. decimals included to avoid mis-scaling.
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ===== UTILITIES =====
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function safeGetDecimals(tokenAddr) {
  try {
    const t = new ethers.Contract(tokenAddr, erc20Abi, provider);
    return await t.decimals();
  } catch {
    // default to 18 if decimals call fails (prevents Infinity)
    return 18;
  }
}

// Robust getAmountsOut with decimal handling and fallbacks
async function getAmountOut(routerAddr, tokenObj, amountInUSDC) {
  if (!routerAddr) return 0;
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    // amountIn to router is in USDC decimals (6)
    const amountInWei = ethers.parseUnits(amountInUSDC.toString(), 6);
    const path = [USDC_ADDRESS, tokenObj.address];

    const amounts = await router.getAmountsOut(amountInWei, path);
    if (!amounts || amounts.length < 2) return 0;

    const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
    const tokenAmount = Number(ethers.formatUnits(amounts[1], decimals));
    // prevent 0 or Infinity
    if (!isFinite(tokenAmount) || tokenAmount <= 0) return 0;
    return tokenAmount;
  } catch (err) {
    // fallback attempt using USDC->WBTC->token path (some routers require intermediate)
    try {
      const router = new ethers.Contract(routerAddr, routerAbi, provider);
      const fallbackPath = [USDC_ADDRESS, tokens.WBTC.address, tokenObj.address];
      const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), fallbackPath);
      if (!amounts || amounts.length < 3) return 0;
      const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
      const tokenAmount = Number(ethers.formatUnits(amounts[2], decimals));
      if (!isFinite(tokenAmount) || tokenAmount <= 0) return 0;
      return tokenAmount;
    } catch (err2) {
      // give up, return 0 to skip this route
      return 0;
    }
  }
}

// read vault USDC balance (in human USDC decimals)
async function getVaultBalance() {
  if (!usdcContract) {
    // attempt to init usdcContract from arbContract.USDC() if not yet initialized
    try {
      const addr = await arbContract.USDC();
      usdcContract = new ethers.Contract(addr, erc20Abi, provider);
    } catch (e) {
      // fallback to provided constant
      usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
    }
  }
  try {
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

// ===== EXECUTOR (keeps your original flow) =====
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();

  // guard: ensure arbContract exists and has the method
  if (!arbContract || typeof arbContract.executeArbitrage !== "function") {
    console.log("❌ arbContract.executeArbitrage is not available — aborting execution");
    return;
  }

  try {
    // vault before
    const beforeBalRaw = await getVaultBalance();
    console.log(`🏦 Vault Before Trade: ${fmt(beforeBalRaw)} USDC`);

    // ------------------ callStatic simulation (no gas) ------------------
    // Important: simulate from the owner address to avoid "Not owner" reverts.
    const walletAddress = await wallet.getAddress();
    try {
      // In ethers v6, callStatic usage: contract.callStatic.method(args..., overrides)
      await arbContract.callStatic.executeArbitrage(
        buyRouter,
        sellRouter,
        tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6),
        { from: walletAddress }
      );
      // if no revert, simulation passed
      console.log("✅ callStatic simulation passed (would not revert)");
    } catch (simErr) {
      console.log("❌ callStatic failed — abort trade:", simErr?.message || simErr);
      return; // safe exit — no gas spent
    }

    // Optional guard: gas estimate + gas->USD check (keep minimal)
    try {
      const estimated = await arbContract.estimateGas.executeArbitrage(
        buyRouter,
        sellRouter,
        tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6)
      );
      // you could convert gas to USD via on-chain price oracle; we keep it as a simple estimate guard
      const gasLimit = estimated.add(ethers.BigNumber.from(10000)); // buffer
      console.log(`⛽ Gas estimate (approx): ${gasLimit.toString()}`);
      // Not aborting here — but you could check if estimate too high
    } catch (gErr) {
      console.log("⚠ estimateGas failed (continuing):", gErr?.message || gErr);
    }

    if (DRY_RUN) {
      console.log("🔬 DRY_RUN enabled — not sending real tx. Simulation only.");
      return;
    }

    // Execute real tx (signed by wallet)
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6),
      { gasLimit: 900_000 }
    );

    // ensure tx hash exists
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

    // verify vault increased (never allow decrease to be logged)
    const netProfit = afterBalRaw - beforeBalRaw;
    if (netProfit <= 0) {
      console.log("❌ Vault did not increase — treating as failed/ignored (no loss logged).");
      return;
    }

    console.log(`💰 Net Profit: ${fmt(netProfit)} USDC`);
    // log CSV entry
    // find symbol
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

// ===== SCAN FUNCTION (original style preserved) =====
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...\n");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(DEX_ROUTERS)) {
      for (const [sellName, sellRouter] of Object.entries(DEX_ROUTERS)) {
        if (buyName === sellName) continue;

        try {
          // Obtain token amounts out for TRADE_AMOUNT_USDC on both routers
          const buyOutTokens = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOutTokens = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          // Skip routes with missing data
          if (buyOutTokens === 0 || sellOutTokens === 0) {
            // console.log(`⚠ skip ${symbol} ${buyName}->${sellName} (missing price)`);
            continue;
          }

          // Compute implied prices: USDC per token = (amountInUSDC) / (tokenAmountOut)
          const buyPrice = TRADE_AMOUNT_USDC / buyOutTokens;
          const sellPrice = TRADE_AMOUNT_USDC / sellOutTokens;

          // Option B style rawProfit = (sellPrice - buyPrice) * tokenAmount
          // Here tokenAmount is approximated by buyOutTokens (amount of token received buying with TRADE_AMOUNT_USDC)
          const tokenAmount = buyOutTokens; // units of token
          const rawProfitUSDC = (sellPrice - buyPrice) * tokenAmount;

          // Also compute profit pct w.r.t buyPrice (approx)
          const profitPct = (buyPrice > 0) ? ( (sellPrice - buyPrice) / buyPrice * 100 ) : 0;

          // Apply slippage guard to reported numbers (conservative)
          const adjustedProfitUSDC = rawProfitUSDC * (1 - SLIPPAGE_PCT / 100);
          const adjustedProfitPct = profitPct * (1 - SLIPPAGE_PCT / 100);

          // print nicely (avoid Infinity or NaN)
          const buyPstr = isFinite(buyPrice) ? fmt(buyPrice,6) : "NaN";
          const sellPstr = isFinite(sellPrice) ? fmt(sellPrice,6) : "NaN";
          const profitStr = isFinite(adjustedProfitUSDC) ? fmt(adjustedProfitUSDC,6) : "NaN";
          const pctStr = isFinite(adjustedProfitPct) ? fmt(adjustedProfitPct,2) : "NaN";

          console.log(`${symbol} | ${buyName} $${buyPstr} → ${sellName} $${sellPstr} | Est. Profit: ${profitStr} USDC (${pctStr}%)`);

          // filters (min absolute and percent)
          if (adjustedProfitUSDC >= MIN_PROFIT_USDC || adjustedProfitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ symbol, buyName, sellName, buyRouter, sellRouter });
            console.log(`🚨 PROFITABLE: executing ${symbol} ${buyName}→${sellName}`);
            // call executor (preserves callStatic, vault checks inside)
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
  // persist CSV (only positive real trades were logged)
  saveCSV();
  return opportunities;
}

// ===== MAIN LOOP =====
async function main() {
  console.log("🚀 LIVE MODE ENABLED — ORIGINAL ARCHITECTURE (minimal edits)");
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
    // fallback
    usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  }

  let loop = 0;
  while (true) {
    loop++;
    console.log(`\n🔁 Scan loop #${loop} — ${new Date().toISOString()}`);
    await scan();
    await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
  }
}

// start
main().catch(err => {
  console.error("Fatal error in arbitrage script:", err && err.stack ? err.stack : err);
  process.exit(1);
});
