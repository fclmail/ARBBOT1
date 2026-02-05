// 🟢1 FILE PURPOSE
// scripts/arbitrage.js
// This script scans DEX prices on Polygon and executes arbitrage
// trades through a deployed Vault smart contract.

import dotenv from "dotenv";
import { ethers } from "ethers";

/**
 * 🟢2 ENVIRONMENT HANDLING
 */
dotenv.config({ override: false });

/* ================= CONFIG ================= */

// 🟢3 RPC URL SELECTION
const RPC_RAW =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

// 🟢4 PRIVATE KEY SELECTION
const PRIVATE_KEY_RAW =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

// 🟢5 NORMALIZATION
const RPC_POLYGON = RPC_RAW.trim();
const WALLET_PRIVATE_KEY = PRIVATE_KEY_RAW.trim();

// 🟢6 STRICT VALIDATION
if (!RPC_POLYGON) throw new Error("RPC_POLYGON is missing or empty");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is missing or empty");

/* ================= CONSTANTS ================= */

// 🟢7 TRADE SETTINGS (UNCHANGED)
const MIN_TRADE_USDC = 1.7;
const MIN_EXPECTED_PROFIT = 0.0000001;
const SLIPPAGE_PCT = 0.05;
const SCAN_INTERVAL_MS = 1_000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

// 🟢8 BLOCKCHAIN CONNECTION
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);

// 🟢9 WALLET INSTANCE
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

// 🟢10 VAULT CONTRACT ADDRESS
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

// 🟢11 VAULT ABI
const vaultAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "uint256", name: "amountInUSDC", type: "uint256" },
      { internalType: "address[]", name: "pathToToken", type: "address[]" },
      { internalType: "address[]", name: "pathToUSDC", type: "address[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

// 🟢12 VAULT CONTRACT INSTANCE
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

// 🟢13 DEX ROUTERS
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// 🟢14 ROUTER ABI
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

// 🟢15 TOKENS
const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE:"0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV:"0x172370d5cd63279efa6d502dab29171933a610af",
  DAI:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  MATICX:"0xa3fa99a148fa48d14ed51d610c367c61876997f1",
  UNI:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  UNI2:"0xb33eaad8d922b1083446dc23f610c2567fb5180f",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

function buildPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token],
    [usdc, TOKENS.USDT, token],
    [usdc, TOKENS.DAI, token],
    [usdc, TOKENS.WMATIC, TOKENS.WETH, token]
  ];
}

/* ================= CORE LOGIC ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {

  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyPaths = buildPaths(usdc, tokenAddr);

  let bestBuyOut = null;
  let bestBuyPath = null;

  for (const p of buyPaths) {
    const out = await quote(buyRouter, amountIn, p);
    if (!out) continue;
    if (!bestBuyOut || out > bestBuyOut) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestBuyOut) return;

  const sellPath = [...bestBuyPath].reverse();

  const sellOut = await quote(sellRouter, bestBuyOut, sellPath);
  if (!sellOut) return;

  const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));
  const profit = receivedUSDC - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log(`🔥 ARB FOUND | Profit ≈ ${profit.toFixed(6)} USDC`);

  /* ================= GAS BUMP ADDED ONLY ================= */

  const fee = await provider.getFeeData();

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    sellPath,
    deadline,
    {
      maxFeePerGas: fee.maxFeePerGas * 120n / 100n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 120n / 100n
    }
  );

  /* ======================================================= */

  console.log(`⛓ TX SENT: ${tx.hash}`);

  tx.wait().then(() => {
    console.log(`✅ CONFIRMED & DEPOSITED | ${tx.hash}`);
  }).catch(() => {});
}

/* ================= SCANNER ================= */

async function scan() {
  console.log(`🔍 Scan started @ ${new Date().toISOString()}`);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        try {
          await tryArb(buy, sell, token);
          await sleep(100);
        } catch (e) {
          console.log(`⚠️ ${e.message}`);
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
