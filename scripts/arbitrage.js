// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – HARDENED (NON-CRASHING)
//  - Uses new vault w/ MIN_PROFIT enforced on-chain
//  - NEVER exits on revert
//  - Keeps GitHub Actions alive (yellow 🟡)
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* =========================================================
   GLOBAL PROCESS SAFETY (CRITICAL FOR CI)
========================================================= */
process.on("unhandledRejection", (reason) => {
  console.log("⚠️ Unhandled rejection caught:", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  console.log("⚠️ Uncaught exception caught:", err.message);
});

/* =========================================================
   CONFIG
========================================================= */
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");

const DRY_RUN = false;
const MIN_TRADE_USDC = 0.0100;
const MIN_EXPECTED_PROFIT = 0.00001;
const MIN_PROFIT_PCT = 1.0;
const SLIPPAGE_PCT = 0.05;
const MAX_PROFIT_PCT = 550;

/* =========================================================
   COLORS
========================================================= */
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmtNum = (n, d = 6) => Number(n).toFixed(d);

/* =========================================================
   PROVIDER / WALLET / VAULT
========================================================= */
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

/* =========================================================
   TOKENS & ROUTERS (UNCHANGED)
========================================================= */
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
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
];

/* =========================================================
   HELPERS
========================================================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function saneProfitPct(p) {
  return Number.isFinite(p) && p > -1000 && p < MAX_PROFIT_PCT;
}

async function getVaultUSDC() {
  try {
    return await vault.USDC();
  } catch {
    return BASE_FALLBACKS[0];
  }
}

async function vaultBalance() {
  const usdc = new ethers.Contract(await getVaultUSDC(), erc20Abi, provider);
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
}

async function safeGetAmountOut(routerAddr, token, amount) {
  try {
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint,address[]) view returns (uint[])"],
      provider
    );
    const amountIn = ethers.parseUnits(amount.toString(), 6);

    for (const base of BASE_FALLBACKS) {
      try {
        const a = await router.getAmountsOut(amountIn, [base, token.address]);
        return Number(ethers.formatUnits(a[1], token.decimals));
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

/* =========================================================
   EXECUTE TRADE (FULLY SANDBOXED)
========================================================= */
async function executeTradeLive(buyRouter, sellRouter, token, amount) {
  try {
    const before = await vaultBalance();
    console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

    if (before < amount) {
      console.log(`${colors.red}❌ Vault insufficient USDC, skipping${colors.reset}`);
      return;
    }

    const buyOut = await safeGetAmountOut(buyRouter, token, amount);
    const sellOut = await safeGetAmountOut(sellRouter, token, amount);
    if (!buyOut || !sellOut) return;

    const buyPrice = amount / buyOut;
    const sellPrice = amount / sellOut;
    const profit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const pct = (profit / buyPrice) * 100;

    if (!saneProfitPct(pct)) return;
    if (profit <= MIN_EXPECTED_PROFIT || pct < MIN_PROFIT_PCT) return;

    console.log(`${colors.green}${token.address} | Expected Profit: ${fmtNum(profit)} USDC | ${fmtNum(pct)}%${colors.reset}`);

    if (DRY_RUN) {
      console.log(`${colors.magenta}🔎 DRY RUN${colors.reset}`);
      return;
    }

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amount.toString(), 6),
      0,
      0,
      Math.floor(Date.now() / 1000) + 60
    ).catch(e => {
      console.log(`${colors.yellow}⚠️ Execution skipped: ${e.message}${colors.reset}`);
      return null;
    });

    if (!tx) return;

    console.log(`${colors.green}🔁 TX SENT ${tx.hash}${colors.reset}`);
    await tx.wait();

    const after = await vaultBalance();
    console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(after - before)} USDC${colors.reset}`);

  } catch (e) {
    console.log(`${colors.yellow}⚠️ Trade error handled: ${e.message}${colors.reset}`);
  }
}

/* =========================================================
   SCAN LOOP (IMMORTAL)
========================================================= */
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        try {
          await executeTradeLive(buy, sell, token, MIN_TRADE_USDC);
          await sleep(1200);
        } catch (e) {
          console.log(`${colors.yellow}⚠️ Scan error absorbed${colors.reset}`);
        }
      }
    }
  }
}

/* =========================================================
   MAIN LOOP (NEVER EXITS)
========================================================= */
(async function main() {
  console.log(`${colors.cyan}🚀 Arbitrage bot started${colors.reset}`);
  while (true) {
    try {
      await scanAllPairs();
    } catch (e) {
      console.log(`${colors.red}⚠️ Loop error absorbed${colors.reset}`);
    }
    await sleep(8000);
  }
})();
