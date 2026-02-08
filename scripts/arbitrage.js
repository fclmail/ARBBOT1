import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const RPC = process.env.RPC_POLYGON;
const PK  = process.env.PRIVATE_KEY;

if (!RPC || !PK) {
  console.error("❌ Missing RPC or PRIVATE_KEY");
  process.exit(1);
}

/* ================= CONFIG ================= */

const MIN_TRADE_USDC = 100;          // realistic size
const MIN_NET_PROFIT = 0.2;          // USDC after gas
const SCAN_INTERVAL = 7000;
const DEADLINE_SEC  = 60;
const GAS_LIMIT     = 320_000n;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(PK, provider);

/* ================= VAULT ================= */

const VAULT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)"
];

const vault = new ethers.Contract(VAULT, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

/* ================= TOKENS ================= */

const TOKENS = {
  WETH:  { addr: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", dec: 18 },
  WMATIC:{ addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", dec: 18 },
  LINK:  { addr: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec: 18 }
};

/* ================= HELPERS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function quote(router, amountIn, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const out = await r.getAmountsOut(amountIn, path);
    return out[out.length - 1];
  } catch {
    return null;
  }
}

/* ================= CORE ARB ================= */

async function tryArb(buyRouter, sellRouter, token) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyPath  = [usdc, TOKENS.WMATIC.addr, token.addr];
  const sellPath = [token.addr, TOKENS.WMATIC.addr, usdc];

  const buyOut = await quote(buyRouter, amountIn, buyPath);
  if (!buyOut) return;

  const sellOut = await quote(sellRouter, buyOut, sellPath);
  if (!sellOut) return;

  const grossProfit =
    Number(ethers.formatUnits(sellOut, 6)) - MIN_TRADE_USDC;

  const gasPrice = await provider.getGasPrice();
  const gasCostMATIC =
    Number(ethers.formatEther(gasPrice * GAS_LIMIT));

  const maticPrice = 0.8; // hard-coded or oracle
  const gasCostUSDC = gasCostMATIC * maticPrice;

  const netProfit = grossProfit - gasCostUSDC;

  console.log(
    `🔎 ${token.addr.slice(0,6)} buy:${buyRouter.slice(0,6)} sell:${sellRouter.slice(0,6)} ` +
    `gross=${grossProfit.toFixed(4)} gas=${gasCostUSDC.toFixed(4)} net=${netProfit.toFixed(4)}`
  );

  if (netProfit < MIN_NET_PROFIT) return;

  console.log(`🔥 EXECUTING ARB → expected +${netProfit.toFixed(4)} USDC`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SEC;

  const args = [
    buyRouter,
    sellRouter,
    amountIn,
    buyPath,
    sellPath,
    deadline
  ];

  await vault.callStatic.executeArbitrage(...args);

  const tx = await vault.executeArbitrage(...args);
  console.log(`⚡ TX SENT: ${tx.hash}`);

  await tx.wait();

  console.log(`🏦 PROFIT DEPOSITED INTO VAULT\n`);
}

/* ================= SCAN LOOP ================= */

async function scan() {
  console.log(`\n🔍 Scan @ ${new Date().toISOString()}`);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(ROUTERS)) {
      for (const sell of Object.values(ROUTERS)) {
        if (buy !== sell) {
          await tryArb(buy, sell, token);
          await sleep(150);
        }
      }
    }
  }
}

/* ================= START ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(e => console.error("❌ ERROR:", e.message));
}, SCAN_INTERVAL);
