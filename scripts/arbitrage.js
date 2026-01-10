// scripts/arbitrage.js
import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

/* ===================== SAFETY ===================== */
process.on("unhandledRejection", e => console.log("⚠️", e?.reason || e));
process.on("uncaughtException", e => console.log("⚠️", e.message));

/* ===================== CONFIG ===================== */
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const MIN_TRADE_USDC = 0.01;
const MIN_PROFIT_USDC = 0.00001;
const MIN_PROFIT_PCT = 0.3;
const SLIPPAGE_PCT = 0.5;

/* ===================== COLORS ===================== */
const C = {
  r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m",
  c: "\x1b[36m", m: "\x1b[35m", x: "\x1b[0m"
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

/* ===================== ADDRESSES ===================== */
const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ===================== TOKENS ===================== */
const tokens = {
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 }
};

/* ===================== ROUTERS ===================== */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ===================== ABIS ===================== */
const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function approveRouter(address,address)"
];

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

/* ===================== CONTRACTS ===================== */
const vault = new ethers.Contract(VAULT, vaultAbi, wallet);
const usdc  = new ethers.Contract(USDC, erc20Abi, provider);

/* ===================== HELPERS ===================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slip = (bn, pct) => bn * BigInt(10000 - pct * 100) / 10000n;

async function vaultBalance() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT), 6));
}

async function maticBalance() {
  return Number(ethers.formatEther(await provider.getBalance(wallet.address)));
}

/* ===================== CORE LOGIC ===================== */
async function attemptArb(buyR, sellR, token) {
  try {
    const buy  = new ethers.Contract(buyR, routerAbi, provider);
    const sell = new ethers.Contract(sellR, routerAbi, provider);

    const usdcIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

    const buyOut = (await buy.getAmountsOut(usdcIn, [USDC, token.address]))[1];
    const sellOut = (await sell.getAmountsOut(buyOut, [token.address, USDC]))[1];

    const profitBN = sellOut - usdcIn;
    const profit = Number(ethers.formatUnits(profitBN, 6));
    const pct = (profit / MIN_TRADE_USDC) * 100;

    console.log(`${C.c}🏦 Vault: ${fmt(await vaultBalance())} USDC${C.x}`);
    console.log(`${C.c}⛽ MATIC: ${fmt(await maticBalance(),4)}${C.x}`);
    console.log(`${C.m}🛒 Buy ${fmt(ethers.formatUnits(buyOut, token.decimals))} ${token.address.slice(0,6)} @ ${buyR.slice(0,6)}${C.x}`);
    console.log(`${C.m}💱 Sell ${fmt(ethers.formatUnits(sellOut,6))} USDC @ ${sellR.slice(0,6)}${C.x}`);

    if (profit <= 0 || profit < MIN_PROFIT_USDC || pct < MIN_PROFIT_PCT) {
      console.log(`${C.y}⚠️ Profit too low${C.x}`);
      return;
    }

    console.log(`${C.g}💰 EXPECTED PROFIT: ${fmt(profit)} USDC (${fmt(pct,2)}%)${C.x}`);

    const tx = await vault.executeArbitrage(
      buyR,
      sellR,
      token.address,
      usdcIn,
      slip(buyOut, SLIPPAGE_PCT),
      slip(sellOut, SLIPPAGE_PCT),
      Math.floor(Date.now() / 1000) + 120
    );

    console.log(`${C.g}🔁 TX SENT: ${tx.hash}${C.x}`);
    await tx.wait();

    console.log(`${C.g}✅ NEW VAULT BALANCE: ${fmt(await vaultBalance())} USDC${C.x}`);

  } catch (e) {
    console.log(`${C.r}⚠️ Trade error: ${e.reason || e.message}${C.x}`);
  }
}

/* ===================== SCANNER ===================== */
async function scan() {
  console.log(`${C.c}🔍 Scanning...${C.x}`);
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await attemptArb(buy, sell, token);
        await sleep(700);
      }
    }
  }
}

/* ===================== MAIN ===================== */
(async () => {
  console.log(`${C.c}🚀 Arb bot running${C.x}`);
  while (true) {
    await scan();
    await sleep(6000);
  }
})();
