// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – WITH LOW-REVERT VAULT FIXES
//  - Enforces minimum profit via vault contract
//  - Correct router approvals without allowance() call
//  - Logs vault balance before & after trades
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not found in environment (GitHub Secrets).");

const DRY_RUN = false; // simulate trades without sending tx
const MIN_TRADE_USDC = 0.15;        // minimum trade size
const MIN_EXPECTED_PROFIT = 0.000001;  // minimum expected profit in USDC
const MIN_PROFIT_PCT = 1.7;         // minimum profit percent threshold
const SLIPPAGE_PCT = 0.05;           // slippage applied to expected profit
const MAX_PROFIT_PCT = 550;          // sanity cap for absurd quoted profit %

const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A"; // LowRevertArbVault
const VAULT_ABI = [ /* ABI trimmed to needed functions */ 
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",
  "function approveRouter(address router,address token) external",
  "function USDC() view returns (address)",
  "function owner() view returns (address)"
];

const TOKENS = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const BASE_FALLBACKS = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmtNum = (n, dec = 6) => Number(n).toFixed(dec);

// ----------------- PROVIDER / WALLET / VAULT -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ----------------- HELPERS -----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getVaultUSDCContract() {
  try {
    const usdcAddr = await vaultContract.USDC();
    return new ethers.Contract(usdcAddr, ERC20_ABI, provider);
  } catch (err) {
    return new ethers.Contract(BASE_FALLBACKS[0], ERC20_ABI, provider);
  }
}

async function getVaultBalance() {
  const usdc = await getVaultUSDCContract();
  const raw = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw, 6));
}

// Quoting helper using multiple bases
async function safeGetAmountOut(routerAddr, tokenObj, amountUSDC) {
  try {
    let usdcAddr;
    try { usdcAddr = (await vaultContract.USDC()).toLowerCase(); } catch { usdcAddr = BASE_FALLBACKS[0]; }
    const bases = [usdcAddr, ...BASE_FALLBACKS.map(b => b.toLowerCase()).filter(b => b !== usdcAddr)];

    const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);

    for (const base of bases) {
      try {
        const amounts = await router.getAmountsOut(amountInRaw, [base, tokenObj.address]);
        return Number(ethers.formatUnits(amounts[1], tokenObj.decimals));
      } catch { continue; }
    }
    return null;
  } catch { return null; }
}

function saneProfitPct(pct) {
  return Number.isFinite(pct) && pct >= -1000 && pct <= MAX_PROFIT_PCT;
}

// Approve router through vault
async function approveRouterIfNeeded(router, tokenAddr) {
  try {
    console.log(`${colors.magenta}Approving router ${router} for token ${tokenAddr} via vault${colors.reset}`);
    const tx = await vaultContract.approveRouter(router, tokenAddr);
    await tx.wait();
    console.log(`${colors.green}Router approved!${colors.reset}`);
  } catch (err) {
    console.log(`${colors.red}Approval failed: ${err?.reason || err?.message || err}${colors.reset}`);
  }
}

// ----------------- CORE TRADE EXECUTION -----------------
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const tokenObj = Object.values(TOKENS).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  try {
    const usdcContract = await getVaultUSDCContract();
    const before = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
    console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`${colors.yellow}⚠️ amount below MIN_TRADE_USDC, skipping${colors.reset}`);
      return;
    }

    // Quoting
    const buyOut = await safeGetAmountOut(buyRouter, tokenObj, amountUSDC);
    const sellOut = await safeGetAmountOut(sellRouter, tokenObj, amountUSDC);
    if (buyOut === null || sellOut === null) return;

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    const expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const expectedProfitPct = (expectedProfitUSDC / buyPrice) * 100;

    if (!saneProfitPct(expectedProfitPct)) return;
    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT || expectedProfitPct < MIN_PROFIT_PCT) {
      console.log(`${colors.yellow}⚠️ Skipping trade — expected profit too low (${fmtNum(expectedProfitUSDC)} USDC / ${fmtNum(expectedProfitPct)}%)${colors.reset}`);
      return;
    }

    console.log(`${expectedProfitUSDC > 0 ? colors.green : colors.red}${tokenAddr} | Expected Profit: ${fmtNum(expectedProfitUSDC)} USDC | pct=${fmtNum(expectedProfitPct)}%${colors.reset}`);

    if (DRY_RUN) {
      console.log(`${colors.magenta}🔎 DRY RUN — not sending tx${colors.reset}`);
      return;
    }

    // Ensure router approval
    await approveRouterIfNeeded(buyRouter, tokenAddr);
    await approveRouterIfNeeded(sellRouter, tokenAddr);

    const deadline = Math.floor(Date.now() / 1000) + 60; // 1 min expiry
    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
    const minTokenOut = 0; // low-revert vault ignores off-chain min
    const minUSDCOut = 0;

    const tx = await vaultContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInRaw, minTokenOut, minUSDCOut, deadline);
    console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
    await tx.wait();

    const after = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
    const netProfit = after - before;
    console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(netProfit)} USDC${colors.reset}`);
  } catch (err) {
    const msg = err?.message || String(err);
    console.log(`${colors.red}⚠️ Unexpected trade error: ${msg}${colors.reset}`);
    if (msg.toLowerCase().includes("rate limit")) await sleep(10000);
  }
}

// ----------------- SCAN LOOP -----------------
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const [symbol, token] of Object.entries(TOKENS)) {
    for (const [buyName, buyRouter] of Object.entries(ROUTERS)) {
      for (const [sellName, sellRouter] of Object.entries(ROUTERS)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await safeGetAmountOut(buyRouter, token, MIN_TRADE_USDC);
          const sellOut = await safeGetAmountOut(sellRouter, token, MIN_TRADE_USDC);
          if (!buyOut || !sellOut) continue;

          const profitUSDC = (MIN_TRADE_USDC / sellOut - MIN_TRADE_USDC / buyOut) * (1 - SLIPPAGE_PCT / 100);
          const profitPct = (profitUSDC / (MIN_TRADE_USDC / buyOut)) * 100;
          if (!saneProfitPct(profitPct)) continue;

          if (profitUSDC > 0) console.log(`${colors.green}${symbol} | ${buyName}→${sellName} | expected profit=${fmtNum(profitUSDC)} USDC | profitPct=${fmtNum(profitPct)}%${colors.reset}`);
          if (profitPct >= MIN_PROFIT_PCT) await executeTradeLive(buyRouter, sellRouter, token.address, MIN_TRADE_USDC);
          await sleep(1200);
        } catch (e) {
          const msg = e?.message || String(e);
          console.log(`${colors.yellow}${symbol} | ${buyName}→${sellName} | scan error: ${msg}${colors.reset}`);
          if (msg.toLowerCase().includes("rate limit")) await sleep(10000);
        }
      }
    }
  }
}

// ----------------- MAIN -----------------
(async function main() {
  console.log(`${colors.cyan}🚀 Live arbitrage runner started${colors.reset}`);
  try {
    const usdcAddr = await vaultContract.USDC();
    console.log(`${colors.cyan}🏛 Vault USDC token: ${usdcAddr}${colors.reset}`);
    const owner = await vaultContract.owner();
    console.log(`${colors.cyan}👤 Vault Owner: ${owner}${colors.reset}`);
  } catch (e) {
    console.log(`${colors.yellow}⚠️ Could not read vault info: ${e.message}${colors.reset}`);
  }

  while (true) {
    try { await scanAllPairs(); } 
    catch (e) { console.log(`${colors.red}Fatal scanner error: ${e.message}${colors.reset}`); }
    await sleep(8000);
  }
})();
