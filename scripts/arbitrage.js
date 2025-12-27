// ---------------------------------------------------------
// ARBITRAGE BOT — FULL MERGED VERSION (MEV-SAFE)
// - ethers v6 safe (BigInt math)
// - Dynamic path discovery per router
// - USDC / WETH / WMATIC multi-hop support
// - Private RPC simulation + send
// - Color-coded logs
// ---------------------------------------------------------

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const DRY_RUN = process.env.DRY_RUN === "true";

const RPC_PUBLIC  = process.env.RPC_PUBLIC  || "https://polygon-rpc.com";
const RPC_PRIVATE = process.env.RPC_PRIVATE || RPC_PUBLIC;

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01);
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.3);
const MAX_PROFIT_PCT = 40;
const VAULT_GUARD_DROP_PCT = 20;

/* =========================================================
   COLORS
========================================================= */
const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const N = "\x1b[0m";

/* =========================================================
   PROVIDERS
========================================================= */
const providerPublic  = new ethers.JsonRpcProvider(RPC_PUBLIC);
const providerPrivate = new ethers.JsonRpcProvider(RPC_PRIVATE);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, providerPrivate);

/* =========================================================
   ROUTERS
========================================================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* =========================================================
   TOKENS
========================================================= */
const tokens = {
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 }
};

/* =========================================================
   COMMON BASE TOKENS (DYNAMIC ROUTING)
========================================================= */
let USDC, WETH, WMATIC;

/* =========================================================
   CONTRACTS
========================================================= */
const arbAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address[] buyPath,address[] sellPath,uint256 amountIn)",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn,address[] calldata path) view returns(uint[] memory)"
];

const arb = new ethers.Contract(
  CONTRACT_ADDRESS,
  arbAbi,
  DRY_RUN ? providerPublic : wallet
);

/* =========================================================
   INIT
========================================================= */
let usdcDecimals = 6;
let usdcContract;
let initialVaultBalance = null;
let vaultGuard = true;

async function init() {
  USDC = await arb.USDC();
  usdcContract = new ethers.Contract(USDC, erc20Abi, providerPublic);
  usdcDecimals = await usdcContract.decimals();

  // Polygon bases
  WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
  WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

  console.log(`${C}🏛 Vault:${N}`, CONTRACT_ADDRESS);
  console.log(`${C}💵 USDC:${N}`, USDC);
  console.log(`${C}🔹 Decimals:${N}`, usdcDecimals);
}

/* =========================================================
   DYNAMIC PATH DISCOVERY
========================================================= */
const BASES = () => [USDC, WETH, WMATIC];

async function discoverPaths(routerAddr, tokenAddr, amountIn) {
  const router = new ethers.Contract(routerAddr, routerAbi, providerPublic);
  const paths = [];

  for (const mid of BASES()) {
    if (mid === tokenAddr) continue;
    paths.push([USDC, mid, tokenAddr]);
  }

  for (const path of paths) {
    try {
      await router.getAmountsOut(amountIn, path);
      return path;
    } catch {}
  }
  return null;
}

/* =========================================================
   AMOUNT OUT
========================================================= */
async function getOut(routerAddr, amountIn, path) {
  const router = new ethers.Contract(routerAddr, routerAbi, providerPublic);
  const amounts = await router.getAmountsOut(amountIn, path);
  return amounts[amounts.length - 1];
}

/* =========================================================
   CORE TRADE
========================================================= */
async function attemptTrade(buyRouter, sellRouter, token) {
  const ts = new Date().toISOString();
  const amountIn = ethers.parseUnits(
    TRADE_AMOUNT_USDC.toString(),
    usdcDecimals
  );

  const vaultBalBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const vaultBal = Number(ethers.formatUnits(vaultBalBN, usdcDecimals));

  if (!initialVaultBalance) initialVaultBalance = vaultBal;
  if (vaultBal < initialVaultBalance * (1 - VAULT_GUARD_DROP_PCT / 100)) {
    vaultGuard = false;
    console.log(`${R}⚠ Vault guard tripped${N}`);
    return;
  }

  const buyPath = await discoverPaths(buyRouter, token.address, amountIn);
  const sellPath = await discoverPaths(sellRouter, USDC, amountIn);

  if (!buyPath || !sellPath) return;

  const tokenOut = await getOut(buyRouter, amountIn, buyPath);
  const usdcOut  = await getOut(sellRouter, tokenOut, sellPath);

  const profitBN = usdcOut - amountIn;
  if (profitBN <= 0n) return;

  const profit = Number(
    ethers.formatUnits(profitBN, usdcDecimals)
  );

  const pct = (profit / TRADE_AMOUNT_USDC) * 100;
  if (pct < MIN_PROFIT_PCT || pct > MAX_PROFIT_PCT) return;

  console.log(`${G}💎 OPPORTUNITY${N}`);
  console.log(`Token: ${token.address}`);
  console.log(`Expected: ${profit.toFixed(6)} USDC`);
  console.log(`Pct: ${pct.toFixed(2)}%`);

  console.log(`${Y}🧪 Simulation running...${N}`);
  try {
    await providerPrivate.call({
      to: CONTRACT_ADDRESS,
      data: arb.interface.encodeFunctionData(
        "executeArbitrage",
        [buyRouter, sellRouter, buyPath, sellPath, amountIn]
      ),
      from: wallet?.address
    });
  } catch {
    console.log(`${R}❌ Simulation FAILED${N}`);
    return;
  }

  console.log(`${G}✅ Simulation PASSED${N}`);

  if (DRY_RUN) return;

  const tx = await arb.executeArbitrage(
    buyRouter,
    sellRouter,
    buyPath,
    sellPath,
    amountIn,
    { gasLimit: 900000 }
  );

  console.log(`${C}🔁 TX SENT${N}`, tx.hash);
  const receipt = await tx.wait();

  if (receipt.status === 1) {
    console.log(`${G}✅ TX MINED — PROFIT REALIZED${N}`);
  }
}

/* =========================================================
   SCANNER
========================================================= */
async function scan() {
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          try {
            await attemptTrade(buy, sell, token);
          } catch {}
        }
      }
    }
  }
}

/* =========================================================
   MAIN
========================================================= */
(async () => {
  await init();
  console.log(`${C}🚀 Arbitrage started${N}`);
  setInterval(scan, 10000);
})();
