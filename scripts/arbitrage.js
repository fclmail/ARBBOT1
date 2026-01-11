// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – VAULT VERSION
//  (FORCED POSITIVE OPPORTUNITY, 1 TX EVERY 4 SECONDS)
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* ===================== GLOBAL SAFETY NET ===================== */
process.on("unhandledRejection", (reason) => {
  console.log("⚠️ Unhandled rejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.log("⚠️ Uncaught exception:", err.message);
});
/* ============================================================= */

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) console.log("❌ Missing PRIVATE KEY");

const DRY_RUN = false;
const MIN_TRADE_USDC = 13.3;
const SLIPPAGE_PCT = 0.05;
const MAX_PROFIT_PCT = 550;

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m"
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ----------------- PROVIDER / WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- VAULT -----------------
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns (address)",
  "function approveRouter(address,address) external"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

// ----------------- TOKENS -----------------
const tokens = {
  AAVE: {
    address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    decimals: 18
  }
};

// ----------------- ROUTERS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ----------------- BASE TOKEN -----------------
const BASE_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ----------------- HELPERS -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sanePct(p) {
  return Number.isFinite(p) && p > -1000 && p < MAX_PROFIT_PCT;
}

// ----------------- FORCED POSITIVE FABRICATION -----------------
function fabricatePositive(amount) {
  // Always +5% to +20%
  const delta = 0.05 + Math.random() * 0.15;
  return amount * (1 + delta);
}

// ----------------- VAULT BALANCE -----------------
async function vaultBalance() {
  const usdc = new ethers.Contract(BASE_USDC, erc20Abi, provider);
  const raw = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw, 6));
}

// ----------------- QUOTE (FABRICATED POSITIVE) -----------------
async function quote(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint,address[]) view returns(uint[])"],
    provider
  );

  const amt = ethers.parseUnits(amountUSDC.toString(), 6);

  try {
    const a = await router.getAmountsOut(amt, [BASE_USDC, token.address]);
    const realOut = Number(ethers.formatUnits(a[1], token.decimals));
    return fabricatePositive(realOut);
  } catch {
    return null;
  }
}

// ----------------- EXECUTION -----------------
async function executeTrade(buyRouter, sellRouter, token) {
  const before = await vaultBalance();
  if (before < MIN_TRADE_USDC) {
    console.log(`${colors.red}❌ Vault balance too low${colors.reset}`);
    return;
  }

  const buyOut = await quote(buyRouter, token, MIN_TRADE_USDC);
  const sellOut = await quote(sellRouter, token, MIN_TRADE_USDC);
  if (!buyOut || !sellOut) return;

  const buyPrice = MIN_TRADE_USDC / buyOut;
  const sellPrice = MIN_TRADE_USDC / sellOut;
  const profit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
  const pct = (profit / buyPrice) * 100;

  if (!sanePct(pct)) return;

  // 🔥 ALWAYS PRINT OPPORTUNITY
  console.log(
    `${colors.green}💰 OPPORTUNITY ${fmt(profit)} USDC (${fmt(pct)}%)${colors.reset}`
  );

  if (DRY_RUN) return;

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    token.address,
    ethers.parseUnits(MIN_TRADE_USDC.toString(), 6),
    Math.floor(buyOut * (1 - SLIPPAGE_PCT / 100)),
    Math.floor(sellOut * (1 - SLIPPAGE_PCT / 100)),
    Math.floor(Date.now() / 1000) + 120
  ).catch(e => {
    console.log(`${colors.red}⚠️ Tx reverted${colors.reset}`);
    return null;
  });

  if (!tx) return;

  console.log(`${colors.cyan}📤 TX SENT ${tx.hash}${colors.reset}`);
  await tx.wait().catch(() => null);

  const after = await vaultBalance();
  console.log(
    `${colors.yellow}🏁 Vault Δ ${fmt(after - before)} USDC${colors.reset}`
  );
}

// ----------------- ONE OPPORTUNITY PER CYCLE -----------------
async function scanOnce() {
  console.log(`⏱️ Scan tick ${new Date().toISOString()}`);

  const token = Object.values(tokens)[0];
  const routerList = Object.values(routers);

  const buy = routerList[Math.floor(Math.random() * routerList.length)];
  let sell;
  do {
    sell = routerList[Math.floor(Math.random() * routerList.length)];
  } while (sell === buy);

  await executeTrade(buy, sell, token);
}

// ----------------- HEARTBEAT -----------------
setInterval(() => {
  console.log("❤️ bot alive");
}, 10000);

// ----------------- MAIN LOOP -----------------
(async () => {
  console.log(`${colors.cyan}🚀 Arb bot running (forced positive, every 4s)${colors.reset}`);

  while (true) {
    await scanOnce();
    await sleep(4000);
  }
})();
