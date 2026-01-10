// scripts/arbitrage.js
import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

/* ================= CONFIG ================= */
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PK = process.env.PRIVATE_KEY;
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PK, provider);

const MIN_TRADE_USDC = 0.01;
const MIN_PROFIT_USDC = 0.00001;
const MIN_PROFIT_PCT = 0.3;
const SLIPPAGE_PCT = 0.5;

/* ================= COLORS ================= */
const C = {
  r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m",
  c: "\x1b[36m", m: "\x1b[35m", x: "\x1b[0m"
};
const fmt = (v, d = 6) => Number(v).toFixed(d);

/* ================= ADDRESSES ================= */
const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= TOKENS ================= */
const tokens = {
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
};

/* ================= DEX ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

/* ================= ABIs ================= */
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

const vault = new ethers.Contract(VAULT, vaultAbi, wallet);
const usdc = new ethers.Contract(USDC, erc20Abi, provider);

/* ================= HELPERS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slip = (bn, pct) => bn * BigInt(10000 - pct * 100) / 10000n;

async function vaultBalance() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT), 6));
}

/* ================= CORE ================= */
async function tryArb(buyR, sellR, token, tradeSize) {
  try {
    const buy = new ethers.Contract(buyR, routerAbi, provider);
    const sell = new ethers.Contract(sellR, routerAbi, provider);

    const usdcIn = ethers.parseUnits(tradeSize.toString(), 6);

    const tokenOut = (await buy.getAmountsOut(usdcIn, [USDC, token.address]))[1];
    const usdcOut  = (await sell.getAmountsOut(tokenOut, [token.address, USDC]))[1];

    const profitBN = usdcOut - usdcIn;
    if (profitBN <= 0n) return;

    const profit = Number(ethers.formatUnits(profitBN, 6));
    const pct = profit / tradeSize * 100;

    console.log(`${C.c}🏦 Vault: ${fmt(await vaultBalance())} USDC${C.x}`);
    console.log(`${C.m}🛒 Buy ${fmt(ethers.formatUnits(tokenOut, token.decimals))} @ ${buyR.slice(0,6)}${C.x}`);
    console.log(`${C.m}💱 Sell ${fmt(ethers.formatUnits(usdcOut,6))} USDC @ ${sellR.slice(0,6)}${C.x}`);

    if (profit < MIN_PROFIT_USDC || pct < MIN_PROFIT_PCT) {
      console.log(`${C.y}⚠️ Profit too low${C.x}`);
      return;
    }

    console.log(`${C.g}💰 PROFIT: ${fmt(profit)} USDC (${fmt(pct,2)}%)${C.x}`);

    const tx = await vault.executeArbitrage(
      buyR,
      sellR,
      token.address,
      usdcIn,
      slip(tokenOut, SLIPPAGE_PCT),
      slip(usdcOut, SLIPPAGE_PCT),
      Math.floor(Date.now()/1000) + 120
    );

    console.log(`${C.g}🔁 TX SENT: ${tx.hash}${C.x}`);
    await tx.wait();

  } catch (e) {
    console.log(`${C.r}⚠️ Trade error: ${e.reason || e.message}${C.x}`);
  }
}

/* ================= SCAN LOOP ================= */
async function scan() {
  console.log("🔍 Scanning...");
  for (const t of Object.values(tokens)) {
    for (const b of Object.values(routers)) {
      for (const s of Object.values(routers)) {
        if (b === s) continue;
        await tryArb(b, s, t, MIN_TRADE_USDC);
        await sleep(700);
      }
    }
  }
}

/* ================= MAIN ================= */
(async () => {
  console.log("🚀 Arb bot running");
  while (true) {
    await scan();
    await sleep(6000);
  }
})();
