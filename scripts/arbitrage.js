// scripts/arbitrage.js

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const RPC_POLYGON = process.env.RPC_POLYGON?.trim();
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONSTANTS ================= */

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;
const TRADE_AMOUNT_USDC = 1.0; // vault-funded, matches your logs

/* ================= CONTRACT ================= */

const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)",
  "function minimumProfitUSDC() view returns(uint256)",
  "function withdrawERC20(address,uint256)"
];

const vault = new ethers.Contract(VAULT_CONTRACT, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:    "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quote(router, amountIn, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const out = await r.getAmountsOut(amountIn, path);
    return out[out.length - 1];
  } catch {
    return null;
  }
}

/* ================= PATH BUILDERS ================= */

function buyPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token]
  ];
}

function sellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc]
  ];
}

/* ================= ARBITRAGE ================= */

async function tryArb(buyRouter, sellRouter, token) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);

  let bestBuy, bestBuyPath;
  for (const p of buyPaths(usdc, token)) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuy || out > bestBuy)) {
      bestBuy = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuy) return;

  let bestSell, bestSellPath;
  for (const p of sellPaths(usdc, token)) {
    const out = await quote(sellRouter, bestBuy, p);
    if (out && (!bestSell || out > bestSell)) {
      bestSell = out;
      bestSellPath = p;
    }
  }
  if (!bestSell) return;

  const profit =
    Number(ethers.formatUnits(bestSell, 6)) - TRADE_AMOUNT_USDC;

  if (profit <= 0) return;

  console.log(`🔥 PROFIT FOUND: ${profit.toFixed(6)} USDCe`);
  console.log(`🧪 SIMULATION START`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const args = [
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    deadline
  ];

  // STATIC SIMULATION
  await vault.callStatic.executeArbitrage(...args);
  console.log(`🧪 SIMULATION PASSED`);

  // EXECUTION
  const tx = await vault.executeArbitrage(...args);
  console.log(`⚡ TX SENT: ${tx.hash}`);
  await tx.wait();
  console.log(`✅ ARBITRAGE CONFIRMED`);
}

/* ================= SCAN ================= */

async function scan() {
  const usdc = await vault.usdc();
  const usdcToken = new ethers.Contract(
    usdc,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );

  const vaultBal = await usdcToken.balanceOf(VAULT_CONTRACT);
  console.log(`🏦 Vault USDC: ${ethers.formatUnits(vaultBal, 6)}`);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await tryArb(buy, sell, token);
          await sleep(100);
        }
      }
    }
  }
}

/* ================= START ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(e => console.error("❌ ERROR:", e.message));
}, SCAN_INTERVAL_MS);
