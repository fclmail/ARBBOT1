// scripts/arbitrage.js
// ---------------------------------------------------------
// ARBITRAGE BOT – STALL-SAFE + RPC ROTATION + AUTO-APPROVAL
// - Fixes frozen logs / silent hangs
// - RPC auto-rotation + hard timeouts
// - USDC allowance auto-check & top-up
// - MEV-safer (public read, stable send)
// - All original features preserved
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ---------------- CONFIG ----------------
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

const DRY_RUN = false;
const TRADE_AMOUNT_USDC = 0.01;
const MIN_PROFIT_PCT = 0.0002;
const SLIPPAGE_PCT = 0.0;
const RPC_TIMEOUT_MS = 8_000;
const APPROVAL_AMOUNT_USDC = 1_000_000;

// ---------------- COLORS ----------------
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

// ---------------- RPC POOL ----------------
// Reliable free Polygon RPCs
const RPC_POOL = [
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon/<YOUR_API_KEY>",
  "https://polygon-mainnet.infura.io/v3/<YOUR_API_KEY>",
  "https://1rpc.io/matic"
];

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_POOL[rpcIndex]);

function rotateRPC(reason) {
  rpcIndex = (rpcIndex + 1) % RPC_POOL.length;
  provider = new ethers.JsonRpcProvider(RPC_POOL[rpcIndex]);
  console.log(`${C.yellow}🔁 RPC ROTATED → ${RPC_POOL[rpcIndex]} (${reason})${C.reset}`);
}

// Timeout wrapper
async function withTimeout(promise, label = "rpc") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), RPC_TIMEOUT_MS)
    )
  ]);
}

// ---------------- WALLET ----------------
let wallet = new Wallet(PRIVATE_KEY, provider);

// ---------------- CONTRACTS ----------------
const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const vaultAbi = [
  {
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { name: "USDC", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" }
];

let vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// ---------------- ROUTERS ----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ---------------- TOKENS ----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ---------------- HELPERS ----------------
function fmt(n, d = 6) { return Number(n).toFixed(d); }

async function getUsdcContract() {
  const usdcAddr = await withTimeout(vault.USDC(), "USDC()");
  return new ethers.Contract(usdcAddr, erc20Abi, wallet);
}

async function getVaultBalance() {
  const usdc = await getUsdcContract();
  const bal = await withTimeout(usdc.balanceOf(VAULT_ADDRESS), "balanceOf");
  return Number(ethers.formatUnits(bal, 6));
}

// Check and auto-approve allowance
async function ensureAllowance(routerAddr, amount) {
  const usdc = await getUsdcContract();
  const currentAllowance = await withTimeout(usdc.allowance(VAULT_ADDRESS, routerAddr), "allowance");
  if (Number(currentAllowance) < ethers.parseUnits(amount.toString(), 6)) {
    console.log(`${C.yellow}🔓 Approving USDC allowance for router ${routerAddr}${C.reset}`);
    if (!DRY_RUN) {
      const tx = await usdc.approve(routerAddr, ethers.parseUnits(APPROVAL_AMOUNT_USDC.toString(), 6));
      await tx.wait();
      console.log(`${C.green}✅ Approval complete${C.reset}`);
    }
  }
}

async function quote(routerAddr, token, amount) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint,address[]) view returns (uint[])"],
    provider
  );
  const usdc = await vault.USDC();
  const path = [usdc, token.address];
  const rawIn = ethers.parseUnits(amount.toString(), 6);
  const out = await withTimeout(router.getAmountsOut(rawIn, path), "getAmountsOut");
  return Number(ethers.formatUnits(out[1], token.decimals));
}

// ---------------- CORE LOGIC ----------------
async function tryTrade(buyRouter, sellRouter, token) {
  console.log(`${C.cyan}────────────────────────────────────${C.reset}`);
  console.log(`🔍 ${new Date().toISOString()} | ${token.address}`);

  try {
    await ensureAllowance(buyRouter, TRADE_AMOUNT_USDC);
    await ensureAllowance(sellRouter, TRADE_AMOUNT_USDC);

    const before = await getVaultBalance();
    console.log(`🏦 Vault: ${fmt(before)} USDC`);

    const buyOut = await quote(buyRouter, token, TRADE_AMOUNT_USDC);
    const sellOut = await quote(sellRouter, token, TRADE_AMOUNT_USDC);

    const buyPrice = TRADE_AMOUNT_USDC / buyOut;
    const sellPrice = TRADE_AMOUNT_USDC / sellOut;
    const profit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const pct = (profit / buyPrice) * 100;

    if (pct < MIN_PROFIT_PCT || !Number.isFinite(pct)) {
      console.log(`⛔ Skip — Profit ${fmt(pct)}%`);
      return;
    }

    console.log(`${C.green}💎 OPPORTUNITY${C.reset}`);
    console.log(`Expected: ${fmt(profit)} USDC`);
    console.log(`Pct: ${fmt(pct)}%`);

    console.log(`🧪 Simulation running...`);
    try {
      const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
      await withTimeout(
        provider.call({
          to: VAULT_ADDRESS,
          data: vault.interface.encodeFunctionData(
            "executeArbitrage",
            [buyRouter, sellRouter, token.address, amountIn]
          )
        }),
        "simulation"
      );
      console.log(`${C.green}✅ Simulation PASSED${C.reset}`);
    } catch {
      console.log(`${C.red}❌ Simulation FAILED${C.reset}`);
      return;
    }

    if (DRY_RUN) return;

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
    );

    console.log(`${C.green}🔁 TX SENT → ${tx.hash}${C.reset}`);
    await tx.wait();

    const after = await getVaultBalance();
    console.log(`${C.green}💰 REAL PROFIT: ${fmt(after - before)} USDC${C.reset}`);

  } catch (e) {
    rotateRPC(e.message);
  }
}

// ---------------- SCANNER ----------------
async function scan() {
  console.log(`${C.magenta}❤️ Scanner heartbeat${C.reset}`);
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await tryTrade(buy, sell, token);
      }
    }
  }
}

// ---------------- MAIN ----------------
(async function main() {
  console.log(`${C.cyan}🚀 Arbitrage started${C.reset}`);
  while (true) {
    try {
      await scan();
    } catch (e) {
      rotateRPC("fatal loop");
    }
    await new Promise(r => setTimeout(r, 6000));
  }
})();
