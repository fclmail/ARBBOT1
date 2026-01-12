// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – FULL UPDATED VERSION
//  - Calls on-chain vault.executeArbitrage(...) when profitable
//  - Logs real USDC vault balance BEFORE and AFTER each trade
//  - Enforces minimum profit and avoids approval stalls
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not found in environment.");

const DRY_RUN = false; // set true to simulate (no on-chain execute)
const MIN_TRADE_USDC = 0.02;        // minimum trade size (USDC)
const MIN_EXPECTED_PROFIT = 0.000001;  // minimum expected profit (USDC)
const MIN_PROFIT_PCT = 1.7;         // percent (e.g. 0.2% profit threshold)
const SLIPPAGE_PCT = 0.05;           // slippage tolerance applied to expectations
const MAX_PROFIT_PCT = 550;          // sanity cap for absurd quoted profit %

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

// Vault contract (with enforce minimum profit smart contract)
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";
const vaultAbi = [
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
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "address", "name": "router", "type": "address" }], "name": "approveRouter", "outputs": [], "stateMutability": "nonpayable", "type": "function" }
];

const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ERC20 ABI (small)
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ----------------- TOKENS & ROUTERS -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

const routers = {
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

// ----------------- HELPERS -----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGetAmountOut(routerAddr, tokenObj, amountUSDC) {
  try {
    let usdcAddr;
    try { usdcAddr = (await vaultContract.USDC()).toLowerCase(); } catch { usdcAddr = BASE_FALLBACKS[0].toLowerCase(); }
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

async function getVaultUsdcContract() {
  try {
    const usdcAddr = await vaultContract.USDC();
    return new ethers.Contract(usdcAddr, erc20Abi, provider);
  } catch {
    return new ethers.Contract(BASE_FALLBACKS[0], erc20Abi, provider);
  }
}

async function getVaultBalanceHuman() {
  const usdc = await getVaultUsdcContract();
  const raw = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw, 6));
}

function saneProfitPct(pct) {
  return Number.isFinite(pct) && pct > -1000 && pct < MAX_PROFIT_PCT;
}

// ----------------- APPROVAL FIX -----------------
const approvedRouters = new Set();
async function approveRouterIfNeeded(router, tokenAddr) {
  const key = `${router}_${tokenAddr}`;
  if (approvedRouters.has(key)) return;

  try {
    console.log(`${colors.magenta}Approving router ${router} for token ${tokenAddr} via vault${colors.reset}`);
    const tx = await vaultContract.approveRouter(tokenAddr, router);
    await Promise.race([tx.wait(), new Promise((_, reject) => setTimeout(() => reject(new Error("tx.wait() timeout")), 15000))]);
    console.log(`${colors.green}Router approved!${colors.reset}`);
    approvedRouters.add(key);
  } catch (err) {
    console.log(`${colors.red}Approval failed: ${err?.reason || err?.message || err}${colors.reset}`);
  }
}

// ----------------- CORE -----------------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  if (amountUSDC < MIN_TRADE_USDC) {
    console.log(`${colors.yellow}⚠️ Trade below MIN_TRADE_USDC, skipping${colors.reset}`);
    return;
  }

  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  const usdcContract = await getVaultUsdcContract();
  const before = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
  console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

  const buyOut = await safeGetAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOut = await safeGetAmountOut(sellRouter, tokenObj, amountUSDC);
  if (buyOut === null || sellOut === null) return;

  const buyPrice = amountUSDC / buyOut;
  const sellPrice = amountUSDC / sellOut;
  const expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
  const expectedProfitPct = (expectedProfitUSDC / buyPrice) * 100;

  if (!saneProfitPct(expectedProfitPct) || expectedProfitUSDC <= MIN_EXPECTED_PROFIT || expectedProfitPct < MIN_PROFIT_PCT) {
    console.log(`${colors.yellow}⚠️ Skipping trade — expected profit too low (${fmtNum(expectedProfitUSDC)} USDC / ${fmtNum(expectedProfitPct)}%)${colors.reset}`);
    return;
  }

  console.log(`${colors.green}${tokenAddr} | Expected Profit: ${fmtNum(expectedProfitUSDC)} USDC | pct=${fmtNum(expectedProfitPct)}%${colors.reset}`);

  // Approve routers if needed
  await approveRouterIfNeeded(buyRouter, tokenAddr);
  await approveRouterIfNeeded(sellRouter, tokenAddr);

  if (DRY_RUN) {
    console.log(`${colors.magenta}🔎 DRY RUN — not sending tx${colors.reset}`);
    return;
  }

  try {
    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
    const tx = await vaultContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInRaw);
    const receipt = await Promise.race([tx.wait(), new Promise((_, reject) => setTimeout(() => reject(new Error("tx.wait() timeout")), 15000))]);

    if (!receipt || receipt.status === 0) {
      console.log(`${colors.red}❌ TX failed${colors.reset}`);
      return;
    }

    const after = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
    const netProfit = after - before;
    cumulativeProfit += netProfit;

    console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(netProfit)} USDC${colors.reset}`);
    console.log(`${colors.cyan}🔔 Trade settled, profits retained in vault.${colors.reset}`);
  } catch (err) {
    console.log(`${colors.red}⚠️ tx send error: ${err?.reason || err?.message || err}${colors.reset}`);
  }
}

// ----------------- SCAN LOOP -----------------
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const token of Object.values(tokens)) {
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

          console.log(profitUSDC > 0
            ? `${colors.green}${token.address} | ${buyName}→${sellName} | expected profit=${fmtNum(profitUSDC)} USDC | profitPct=${fmtNum(profitPct)}%${colors.reset}`
            : `${colors.red}${token.address} | ${buyName}→${sellName} | expected loss=${fmtNum(profitUSDC)} USDC | profitPct=${fmtNum(profitPct)}%${colors.reset}`);

          if (profitPct >= MIN_PROFIT_PCT) {
            await executeTradeLive(buyRouter, sellRouter, token.address, MIN_TRADE_USDC);
            await sleep(1200);
          }
        } catch (e) {
          const msg = e?.message || String(e);
          console.log(`${colors.yellow}${token.address} scan error: ${msg}${colors.reset}`);
          if (msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("too many requests")) {
            await sleep(10000);
          }
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
