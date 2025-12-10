//🟢✅ ARB8 FULL LIVE ARBITRAGE (JS-only safety & simulation fixes)

import { ethers, Wallet } from "ethers";
import fs from "fs";

// ---------- CONFIG ----------
const DRY_RUN = false; // 🚀 LIVE TRADES
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

// Hardcoded Polygon RPC + Vault Contract
const RPC_URL = "https://polygon-rpc.com"; 
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // stored in secrets

if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// Trading thresholds
const MIN_PROFIT_PCT = 20; // threshold applied to percent profit relative to amountIn (optional)
const MIN_TRADE_USDC = 0.01;
const MIN_EXPECTED_PROFIT = 0.001; // USDC
const SLIPPAGE_PCT = 0.0;
const MAX_PROFIT_PCT = 40;
const TRADE_AMOUNT_USDC = 0.01;

// Routers and Tokens
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
  } catch (e) {
    console.warn("⚠️ Initialization warning:", e.message);
  }
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }
const colors = { reset:"\x1b[0m", red:"\x1b[31m", green:"\x1b[32m", yellow:"\x1b[33m", cyan:"\x1b[36m" };

/**
 * Get token amount you would receive when swapping `amountUSDC` USDC -> token via routerAddr.
 * Returns Number of token units (human units, not wei).
 */
async function getTokenAmountFromUSDC(routerAddr, token, amountUSDC) {
  try {
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
      provider
    );
    const usdcAddr = await arbContract.USDC();
    const path = [usdcAddr, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), path);
    // amounts[1] is token amount in raw units
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    // don't spam with full error
    // keep same warning style as original
    console.log(`${colors.yellow}⚠️ ${token.address} | Router ${routerAddr} quote failed (USDC→token), skipping${colors.reset}`);
    return null;
  }
}

/**
 * Get USDC amount you would receive when swapping `tokenAmount` token -> USDC via routerAddr.
 * tokenAmount is in human units (not wei).
 * Returns Number of USDC (human units).
 */
async function getUSDCAmountFromToken(routerAddr, token, tokenAmount) {
  try {
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
      provider
    );
    const usdcAddr = await arbContract.USDC();
    const path = [token.address, usdcAddr];
    // tokenAmount must be encoded with token.decimals
    const tokenAmountRaw = ethers.parseUnits(tokenAmount.toString(), token.decimals);
    const amounts = await router.getAmountsOut(tokenAmountRaw, path);
    return Number(ethers.formatUnits(amounts[1], 6)); // USDC decimals = 6
  } catch (err) {
    console.log(`${colors.yellow}⚠️ ${token.address} | Router ${routerAddr} quote failed (token→USDC), skipping${colors.reset}`);
    return null;
  }
}

// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  try {
    // Vault balance before
    const before = Number(ethers.formatUnits(await usdcContract.balanceOf(CONTRACT_ADDRESS), 6));
    console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmt(before)} USDC${colors.reset}`);

    if (amountUSDC < MIN_TRADE_USDC) return;

    // Ensure vault has at least amountUSDC
    if (before < amountUSDC) {
      console.log(`${colors.red}⛔ Vault does not have enough USDC (has ${fmt(before)}, needs ${fmt(amountUSDC)}) — skipping.${colors.reset}`);
      return;
    }

    // --- SIMULATE THE 2-LEG ON-CHAIN OUTCOME USING ROUTER QUOTES ---
    // 1) How many tokens would we get by swapping amountUSDC on buyRouter?
    const buyTokenAmount = await getTokenAmountFromUSDC(buyRouter, tokenObj, amountUSDC);
    if (buyTokenAmount === null) return;

    // 2) How much USDC would we get by selling that token amount on sellRouter?
    const sellUSDCAmount = await getUSDCAmountFromToken(sellRouter, tokenObj, buyTokenAmount);
    if (sellUSDCAmount === null) return;

    // 3) Compute expected profit (USDC)
    // profit = USDC_out_after_sell - USDC_in
    const expectedProfitUSDC = (sellUSDCAmount - amountUSDC) * (1 - SLIPPAGE_PCT/100);
    const expectedProfitPct = (expectedProfitUSDC / amountUSDC) * 100;

    // Enforce thresholds
    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      // too small to bother
      return;
    }
    if (expectedProfitPct > MAX_PROFIT_PCT) {
      // sanity filter
      return;
    }

    // For logging keep old style name printed tokenAddr
    console.log(`${expectedProfitUSDC > 0 ? colors.green : colors.red}${tokenAddr} | Expected Profit: ${fmt(expectedProfitUSDC)} USDC | pct=${fmt(expectedProfitPct)}%${colors.reset}`);

    // MUST only proceed if simulated expected profit is positive
    if (expectedProfitUSDC <= 0) {
      console.log(`${colors.red}⛔ Simulated outcome non-positive — skipping to avoid vault loss.${colors.reset}`);
      return;
    }

    // Optional extra safety: ensure the profitPct passes your MIN_PROFIT_PCT threshold
    if (expectedProfitPct < MIN_PROFIT_PCT) {
      console.log(`${colors.yellow}ℹ️ Profit pct ${fmt(expectedProfitPct)}% < MIN_PROFIT_PCT ${MIN_PROFIT_PCT}% — skipping.${colors.reset}`);
      return;
    }

    // At this point, simulation shows a net positive USDC -> safe to send tx (JS-only guarantee)
    // Live trade (only send if not dry run)
    if (DRY_RUN) {
      console.log(`${colors.cyan}🔬 DRY RUN: would send executeArbitrage(${buyRouter}, ${sellRouter}, ${tokenAddr}, ${amountUSDC})${colors.reset}`);
      // simulate final "after" for logging purposes
      const simulatedAfter = before + expectedProfitUSDC;
      console.log(`${colors.green}💰 SIMULATED REAL PROFIT: ${fmt(expectedProfitUSDC)} USDC — simulated vault after: ${fmt(simulatedAfter)} USDC${colors.reset}`);
      logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: expectedProfitUSDC });
      return;
    }

    // Send transaction
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6)
    );
    console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      console.log(`${colors.red}❌ TX failed${colors.reset}`);
    } else {
      // Re-check vault balance AFTER on-chain execution
      const after = Number(ethers.formatUnits(await usdcContract.balanceOf(CONTRACT_ADDRESS), 6));
      const netProfit = after - before;
      cumulativeProfit += netProfit;

      // If the real netProfit is <= 0, log a warning — this should not happen given our simulation,
      // but network conditions / sandwich / MEV can cause diff — we handle gracefully.
      if (netProfit <= 0) {
        console.log(`${colors.red}❌ REAL profit non-positive (after: ${fmt(after)}, before: ${fmt(before)}). Net: ${fmt(netProfit)} USDC${colors.reset}`);
        // Do not record negative profit into cumulative (we already added above, but we can subtract back)
        // adjust cumulativeProfit back
        cumulativeProfit -= netProfit; // undo addition of non-positive netProfit
        // optional: record to CSV with negative flag
        logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });
      } else {
        console.log(`${colors.green}💰 REAL PROFIT: ${fmt(netProfit)} USDC${colors.reset}`);
        logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });
        console.log(`${colors.cyan}🔔 Trade settled, profits deposited to vault (approx).${colors.reset}`);
      }
    }

  } catch (err) {
    console.log(`${colors.red}⚠️ Unexpected trade error: ${err.message}${colors.reset}`);
  }
}

// ---------- SCAN LOOP ----------
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          // SIMULATE buy token amount (USDC -> token) on buyRouter
          const buyOutTokens = await getTokenAmountFromUSDC(buyRouter, token, TRADE_AMOUNT_USDC);
          if (buyOutTokens === null) continue;

          // SIMULATE USDC we would get when selling that token amount on sellRouter
          const sellOutUSDC = await getUSDCAmountFromToken(sellRouter, token, buyOutTokens);
          if (sellOutUSDC === null) continue;

          // Profit calculation: sellOutUSDC - amountIn
          const profitUSDC = (sellOutUSDC - TRADE_AMOUNT_USDC) * (1 - SLIPPAGE_PCT/100);
          const profitPct = (profitUSDC / TRADE_AMOUNT_USDC) * 100;

          if (profitUSDC > 0) {
            console.log(`${colors.green}${symbol} | ${buyName}→${sellName} | profit=${fmt(profitUSDC)} USDC | profitPct=${fmt(profitPct)}%${colors.reset}`);
          } else {
            console.log(`${colors.red}${symbol} | ${buyName}→${sellName} | loss=${fmt(profitUSDC)} USDC | profitPct=${fmt(profitPct)}%${colors.reset}`);
          }

          // only attempt trade if simulation shows positive profit and profitPct threshold
          if (profitPct >= MIN_PROFIT_PCT && profitUSDC > MIN_EXPECTED_PROFIT) {
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.log(`${colors.yellow}${symbol} | ${buyName}→${sellName} | scan error: ${e.message}${colors.reset}`);
        }
      }
    }
  }
  saveCSV();
}

// ---------- MAIN ----------
(async function main() {
  await init();
  console.log("🚀 Live arbitrage runner started");

  setInterval(async () => {
    try { await scanAllPairs(); }
    catch (e) { console.log(`${colors.red}Fatal scanner error: ${e.message}${colors.reset}`); }
  }, 10000);
})();
