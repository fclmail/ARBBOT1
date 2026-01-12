// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – VAULT VERSION (RAW HTML-STYLE PRICING)
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
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE KEY");

const MIN_TRADE_USDC = 0.05;
const SLIPPAGE_PCT = 0.05;

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ----------------- RPC ROTATION -----------------
const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon-public.nodies.app",
  "https://polygon.drpc.org"
];

let rpcIndex = 0;
function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url, { chainId: 137, name: "matic" });
}

let provider = newProvider();
let wallet = new Wallet(PRIVATE_KEY, provider);

async function rpc(fn) {
  try {
    return await fn();
  } catch (e) {
    console.log("🔁 RPC rotate");
    provider = newProvider();
    wallet = new Wallet(PRIVATE_KEY, provider);
    return fn();
  }
}

// ----------------- VAULT -----------------
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function approveRouter(address router,address token)",
  "function USDC() view returns(address)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "function allowance(address,address) view returns(uint256)"
];

// ----------------- TOKENS -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ----------------- ROUTERS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ----------------- HELPERS -----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function walletMatic() {
  return Number(ethers.formatEther(await provider.getBalance(wallet.address)));
}

async function vaultUSDCAddr() {
  return await vault.USDC();
}

async function vaultBalance() {
  const usdc = new ethers.Contract(await vaultUSDCAddr(), erc20Abi, provider);
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
}

// ----------------- RAW HTML-STYLE QUOTE -----------------
async function quoteArb(buyRouter, sellRouter, token, amountUSDC) {
  const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])"
  ];

  const buyC  = new ethers.Contract(buyRouter, routerAbi, provider);
  const sellC = new ethers.Contract(sellRouter, routerAbi, provider);

  const usdcIn = ethers.parseUnits(amountUSDC.toString(), 6);

  // BUY: USDC -> TOKEN
  const buyPath = [await vaultUSDCAddr(), token.address];
  const buyAmounts = await buyC.getAmountsOut(usdcIn, buyPath);
  const tokenOut = buyAmounts[1];

  // SELL: TOKEN -> USDC
  const sellPath = [token.address, await vaultUSDCAddr()];
  const sellAmounts = await sellC.getAmountsOut(tokenOut, sellPath);
  const usdcOut = sellAmounts[1];

  return { tokenOut, usdcOut };
}

// ----------------- AUTO APPROVE -----------------
async function ensureApprovals() {
  console.log(`${colors.cyan}🔑 Ensuring approvals...${colors.reset}`);
  for (const token of Object.values(tokens)) {
    for (const router of Object.values(routers)) {
      try {
        await vault.approveRouter(router, token.address);
      } catch {}
      await sleep(200);
    }
  }
}

// ----------------- EXECUTION -----------------
async function executeTrade(buyRouter, sellRouter, token, amountUSDC) {
  try {
    const before = await vaultBalance();
    const matic = await walletMatic();

    const { usdcOut } = await quoteArb(buyRouter, sellRouter, token, amountUSDC);

    const usdcInNum  = amountUSDC;
    const usdcOutNum = Number(ethers.formatUnits(usdcOut, 6));

    const rawProfit = usdcOutNum - usdcInNum;
    const profitAdj = rawProfit * (1 - SLIPPAGE_PCT / 100);
    const pct = (profitAdj / usdcInNum) * 100;

    console.log(
      `${colors.magenta}${token.address.slice(0,6)} | BUY ${fmt(usdcInNum)} → SELL ${fmt(usdcOutNum)} | PROFIT ${fmt(rawProfit)} (${fmt(pct,2)}%)${colors.reset}`
    );

    // Let contract decide (NO_PROFIT revert)
    await vault.executeArbitrage.staticCall(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amountUSDC.toString(), 6),
      0,
      0,
      Math.floor(Date.now() / 1000) + 120
    );

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amountUSDC.toString(), 6),
      0,
      0,
      Math.floor(Date.now() / 1000) + 120
    );

    console.log(`${colors.green}📤 TX: ${tx.hash}${colors.reset}`);
    await tx.wait();

    const after = await vaultBalance();
    console.log(`${colors.green}✅ REAL PROFIT: ${fmt(after - before)} USDC${colors.reset}`);
    console.log(`${colors.cyan}🏦 Vault: ${fmt(after)} | 👛 MATIC: ${fmt(matic,4)}${colors.reset}`);

  } catch {
    // silent revert = NO_PROFIT
  }
}

// ----------------- SCANNER -----------------
async function scan() {
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await executeTrade(buy, sell, token, MIN_TRADE_USDC);
          await sleep(700);
        }
      }
    }
  }
}

// ----------------- MAIN -----------------
(async () => {
  console.log(`${colors.cyan}🚀 RAW Arb Bot Started${colors.reset}`);
  await ensureApprovals();
  while (true) {
    await scan();
    await sleep(6000);
  }
})();
