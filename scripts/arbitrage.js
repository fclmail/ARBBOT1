// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – FULL RESTORED & FIXED VERSION
//  - Calls LowRevertArbVault.executeArbitrage(...) with min profit enforcement
//  - Automatically approves routers if needed
//  - Logs real USDC vault balance BEFORE and AFTER each trade
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not found in environment");

const DRY_RUN = false; // simulate trades
const MIN_TRADE_USDC = 0.02; // minimum trade size (USDC)
const MIN_EXPECTED_PROFIT = 0.000001; // minimum expected profit (USDC)
const MIN_PROFIT_PCT = 1.7; // minimum percent profit
const SLIPPAGE_PCT = 0.05; // slippage tolerance for expectation
const MAX_PROFIT_PCT = 550; // sanity cap for absurd quoted profit %

const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A"; // LowRevertArbVault

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

// ----------------- PROVIDER / WALLET / CONTRACT -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- VAULT CONTRACT -----------------
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function approveRouter(address router,address token) external"
];

const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 ABI -----------------
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// ----------------- TOKENS & ROUTERS -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const BASE_FALLBACKS = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

// ----------------- HELPERS -----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getVaultUSDCContract() {
  try {
    const usdcAddr = await vaultContract.USDC();
    return new ethers.Contract(usdcAddr, erc20Abi, provider);
  } catch {
    return new ethers.Contract(BASE_FALLBACKS[0], erc20Abi, provider);
  }
}

async function getVaultBalanceHuman() {
  const usdc = await getVaultUSDCContract();
  const raw = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw, 6));
}

function saneProfitPct(pct) {
  if (!Number.isFinite(pct)) return false;
  if (pct < -1000 || pct > MAX_PROFIT_PCT) return false;
  return true;
}

async function safeGetAmountOut(routerAddr, tokenObj, amountUSDC) {
  try {
    let usdcAddr = (await vaultContract.USDC()).toLowerCase();
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

async function approveRouterIfNeeded(router, tokenAddr) {
  try {
    const usdc = new ethers.Contract(tokenAddr, erc20Abi, wallet);
    const allowance = await usdc.allowance(VAULT_ADDRESS, router);
    if (allowance < ethers.parseUnits("0.01", 6)) {
      console.log(`${colors.magenta}Approving router ${router} for token ${tokenAddr}${colors.reset}`);
      const tx = await vaultContract.approveRouter(router, tokenAddr);
      await tx.wait();
      console.log(`${colors.green}Router approved!${colors.reset}`);
    }
  } catch (err) {
    console.log(`${colors.red}Approval failed: ${err.message}${colors.reset}`);
  }
}

// ----------------- CORE TRADE EXECUTION -----------------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };

  const usdcContract = await getVaultUSDCContract();
  const before = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
  console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

  if (amountUSDC < MIN_TRADE_USDC) {
    console.log(`${colors.yellow}⚠️ Amount below MIN_TRADE_USDC, skipping${colors.reset}`);
    return;
  }

  const buyOut = await safeGetAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOut = await safeGetAmountOut(sellRouter, tokenObj, amountUSDC);
  if (buyOut === null || sellOut === null) {
    console.log(`${colors.yellow}⚠️ Quote missing, skipping${colors.reset}`);
    return;
  }

  const buyPrice = amountUSDC / buyOut;
  const sellPrice = amountUSDC / sellOut;
  let expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
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

  // --- APPROVE ROUTERS ---
  await approveRouterIfNeeded(buyRouter, await vaultContract.USDC());
  await approveRouterIfNeeded(sellRouter, tokenAddr);

  // --- EXECUTE ON-CHAIN ---
  const deadline = Math.floor(Date.now() / 1000) + 60; // 60s deadline
  const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
  const minTokenOutRaw = ethers.parseUnits((buyOut * 0.99).toFixed(tokenObj.decimals), tokenObj.decimals);
  const minUSDCOutRaw = ethers.parseUnits((amountUSDC + expectedProfitUSDC * 0.95).toFixed(6), 6);

  try {
    const tx = await vaultContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      amountInRaw,
      minTokenOutRaw,
      minUSDCOutRaw,
      deadline
    );
    console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log(`${colors.red}❌ TX failed${colors.reset}`);
      return;
    }
  } catch (err) {
    console.log(`${colors.red}⚠️ tx send error: ${err?.reason || err?.message || err}${colors.reset}`);
    return;
  }

  const after = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
  const netProfit = after - before;
  cumulativeProfit += netProfit;
  console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(netProfit)} USDC${colors.reset}`);
}

// ----------------- SCAN LOOP -----------------
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await safeGetAmountOut(buyRouter, token, MIN_TRADE_USDC);
          const sellOut = await safeGetAmountOut(sellRouter, token, MIN_TRADE_USDC);
          if (buyOut === null || sellOut === null) continue;

          const buyPrice = MIN_TRADE_USDC / buyOut;
          const sellPrice = MIN_TRADE_USDC / sellOut;
          const profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
          const profitPct = (profitUSDC / buyPrice) * 100;

          if (!saneProfitPct(profitPct)) continue;

          if (profitUSDC > 0) {
            console.log(`${colors.green}${symbol} | ${buyName}→${sellName} | expected profit=${fmtNum(profitUSDC)} USDC | profitPct=${fmtNum(profitPct)}%${colors.reset}`);
          }

          if (profitPct >= MIN_PROFIT_PCT) {
            await executeTradeLive(buyRouter, sellRouter, token.address, MIN_TRADE_USDC);
            await sleep(1200);
          }
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
    try {
      await scanAllPairs();
    } catch (e) {
      console.log(`${colors.red}Fatal scanner error: ${e.message}${colors.reset}`);
    }
    await sleep(8000);
  }
})();
