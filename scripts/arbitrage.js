// scripts/arbitrage.js
import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* ===================== SAFETY ===================== */
process.on("unhandledRejection", e => console.log("⚠️", e?.message || e));
process.on("uncaughtException", e => console.log("⚠️", e.message));

/* ===================== CONFIG ===================== */
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw "Missing PRIVATE_KEY";

const MIN_TRADE_USDC = 0.05;
const MIN_PROFIT_USDC = 0.00001;
const MIN_PROFIT_PCT = 1.0;
const SLIPPAGE = 0.05;

/* ===================== RPC ROTATION ===================== */
const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon-public.nodies.app",
  "https://polygon.drpc.org"
];

const providers = RPCS.map(url => ({
  provider: new ethers.JsonRpcProvider(url, 137),
  weight: 1
}));

const provider = new ethers.FallbackProvider(providers, 1);
const wallet = new Wallet(PRIVATE_KEY, provider);

/* ===================== VAULT ===================== */
const VAULT = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";
const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns (address)",
  "function approveRouter(address,address)"
];
const vault = new ethers.Contract(VAULT, vaultAbi, wallet);

/* ===================== ERC20 ===================== */
const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)"
];

/* ===================== DEX ROUTERS ===================== */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ===================== TOKENS ===================== */
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ===================== HELPERS ===================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = n => Number(n).toFixed(6);

async function vaultBalance() {
  const usdc = new ethers.Contract(USDC, erc20Abi, provider);
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT), 6));
}

async function ensureApproval(token, router) {
  const erc = new ethers.Contract(token, erc20Abi, provider);
  const allowance = await erc.allowance(VAULT, router);
  if (allowance > 0n) return;
  await vault.approveRouter(router, token);
}

async function quote(router, amountIn, path) {
  const r = new ethers.Contract(router, ["function getAmountsOut(uint,address[]) view returns(uint[])"], provider);
  const out = await r.getAmountsOut(amountIn, path);
  return out[out.length - 1];
}

/* ===================== CORE ARB ===================== */
async function tryArb(buyRouter, sellRouter, token) {
  try {
    const before = await vaultBalance();

    const usdcIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

    // Buy quote: USDC -> TOKEN
    const tokenOut = await quote(buyRouter, usdcIn, [USDC, token.address]);

    // Sell quote: TOKEN -> USDC
    const usdcOut = await quote(sellRouter, tokenOut, [token.address, USDC]);

    const profit = Number(ethers.formatUnits(usdcOut - usdcIn, 6));
    const pct = (profit / MIN_TRADE_USDC) * 100;

    if (profit < MIN_PROFIT_USDC || pct < MIN_PROFIT_PCT) return;

    console.log(`🏦 Vault Before: ${fmt(before)} USDC`);
    console.log(`💰 Expected Profit: ${fmt(profit)} USDC (${fmt(pct)}%)`);
    console.log(`📈 Buy: ${fmt(MIN_TRADE_USDC / Number(ethers.formatUnits(tokenOut, token.decimals)))}, Sell: ${fmt(MIN_TRADE_USDC / Number(ethers.formatUnits(usdcOut, 6)))}`);

    await ensureApproval(USDC, buyRouter);
    await ensureApproval(token.address, sellRouter);

    const minToken = tokenOut * 995n / 1000n;
    const minUSDC = usdcOut * 995n / 1000n;

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      usdcIn,
      minToken,
      minUSDC,
      Math.floor(Date.now() / 1000) + 120
    );

    console.log(`🔁 TX SENT: ${tx.hash}`);
    console.log("⏳ Waiting for confirmation...");

    await tx.wait();

    const after = await vaultBalance();
    console.log(`✅ Vault After: ${fmt(after)} USDC`);
    console.log(`REAL PROFIT: ${fmt(after - before)} USDC\n`);
  } catch (e) {
    console.log("⚠️ Trade error:", e.reason || e.message);
  }
}

/* ===================== LOOP ===================== */
(async () => {
  console.log("🚀 Arb bot running\n");

  while (true) {
    for (const token of Object.values(tokens)) {
      for (const buy of Object.values(routers)) {
        for (const sell of Object.values(routers)) {
          if (buy !== sell) await tryArb(buy, sell, token);
        }
      }
    }
    await sleep(6000);
  }
})();
