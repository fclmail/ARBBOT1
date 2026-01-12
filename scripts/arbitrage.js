// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – CONTINUOUS SCAN + FALLBACK PATHS
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* ===================== SAFETY ===================== */
process.on("unhandledRejection", (r) =>
  console.log("⚠️ Unhandled rejection:", r?.message || r)
);
process.on("uncaughtException", (e) =>
  console.log("⚠️ Uncaught exception:", e.message)
);
/* ================================================= */

// ---------------- CONFIG ----------------
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE KEY");

const DRY_RUN = false;
const TRADE_USDC = 0.05;
const MIN_PROFIT_USDC = 0.00001;
const MIN_PROFIT_PCT = 0.2;
const SLIPPAGE_PCT = 0.05;
const MAX_PROFIT_PCT = 500;

// ---------------- COLORS ----------------
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ---------------- RPC ----------------
const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
];

let rpcIndex = 0;
function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url, { chainId: 137 });
}

let provider = newProvider();
let wallet = new Wallet(PRIVATE_KEY, provider);

async function rpc(fn) {
  try {
    return await fn(provider);
  } catch {
    provider = newProvider();
    wallet = new Wallet(PRIVATE_KEY, provider);
    return fn(provider);
  }
}

// ---------------- ADDRESSES ----------------
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// ---------------- ABI ----------------
const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
];
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
];

// ---------------- CONTRACTS ----------------
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ---------------- TOKENS ----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

// ---------------- ROUTERS ----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

// ---------------- HELPERS ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function walletMatic() {
  return Number(
    ethers.formatEther(await rpc(() => provider.getBalance(wallet.address)))
  );
}

async function vaultBalance() {
  const usdc = new ethers.Contract(USDC, erc20Abi, provider);
  return Number(
    ethers.formatUnits(await rpc(() => usdc.balanceOf(VAULT_ADDRESS)), 6)
  );
}

// ---------------- FALLBACK PATHS ----------------
const buyPaths = (t) => [
  [USDC, t.address],
  [USDC, WMATIC, t.address],
  [USDC, WETH, t.address],
];

const sellPaths = (t) => [
  [t.address, USDC],
  [t.address, WMATIC, USDC],
  [t.address, WETH, USDC],
];

// ---------------- QUOTES ----------------
async function quote(router, amountIn, path, outDecimals) {
  const r = new ethers.Contract(
    router,
    ["function getAmountsOut(uint,address[]) view returns(uint[])"],
    provider
  );
  try {
    const out = await rpc(() => r.getAmountsOut(amountIn, path));
    return Number(ethers.formatUnits(out.at(-1), outDecimals));
  } catch {
    return null;
  }
}

async function quoteBuy(router, token) {
  const amt = ethers.parseUnits(TRADE_USDC.toString(), 6);
  for (const path of buyPaths(token)) {
    const out = await quote(router, amt, path, token.decimals);
    if (out && out > 0) return out;
  }
  return null;
}

async function quoteSell(router, token, tokenAmt) {
  const amt = ethers.parseUnits(tokenAmt.toString(), token.decimals);
  for (const path of sellPaths(token)) {
    const out = await quote(router, amt, path, 6);
    if (out && out > 0) return out;
  }
  return null;
}

// ---------------- ARBITRAGE ----------------
async function tryArb(buy, sell, token) {
  const tokensOut = await quoteBuy(buy, token);
  if (!tokensOut) return;

  const usdcOut = await quoteSell(sell, token, tokensOut);
  if (!usdcOut) return;

  const profit = usdcOut - TRADE_USDC;
  const pct = (profit / TRADE_USDC) * 100;

  console.log(
    `${token.address.slice(0,6)} | BUY ${fmt(TRADE_USDC)} → SELL ${fmt(usdcOut)} | PROFIT ${fmt(profit)} (${fmt(pct,2)}%)`
  );

  if (
    profit < MIN_PROFIT_USDC ||
    pct < MIN_PROFIT_PCT ||
    pct > MAX_PROFIT_PCT
  ) return;

  console.log(`${C.green}💰 ARB FOUND${C.reset}`);
  if (DRY_RUN) return;

  const before = await vaultBalance();

  const tx = await vault.executeArbitrage(
    buy,
    sell,
    token.address,
    ethers.parseUnits(TRADE_USDC.toString(), 6),
    Math.floor(tokensOut * (1 - SLIPPAGE_PCT / 100)),
    Math.floor(usdcOut * (1 - SLIPPAGE_PCT / 100)),
    Math.floor(Date.now() / 1000) + 120
  );

  await tx.wait();

  const after = await vaultBalance();
  console.log(`${C.green}✅ REAL PROFIT: ${fmt(after - before)} USDC${C.reset}`);
}

// ---------------- CONTINUOUS SCAN ----------------
async function scanForever() {
  console.log(`${C.cyan}🚀 Continuous Arb Scan Started${C.reset}`);
  console.log(`💳 Wallet MATIC: ${fmt(await walletMatic(), 4)}`);
  console.log(`🏦 Vault USDC: ${fmt(await vaultBalance())}`);

  while (true) {
    for (const token of Object.values(tokens)) {
      for (const buy of Object.values(routers)) {
        for (const sell of Object.values(routers)) {
          if (buy !== sell) {
            await tryArb(buy, sell, token);
            await sleep(200); // RPC safety
          }
        }
      }
    }
  }
}

// ---------------- MAIN ----------------
scanForever();
