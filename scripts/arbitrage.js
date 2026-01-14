// scripts/arbitrage.js
import dotenv from "dotenv";
import { ethers } from "ethers";

/**
 * IMPORTANT:
 * - GitHub Actions already injects env vars
 * - Do NOT override them with dotenv
 */
dotenv.config({ override: false });

/* ================= CONFIG ================= */

// Support multiple env names (safe fallback)
const RPC_RAW =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const PRIVATE_KEY_RAW =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

// Normalize values (fix whitespace / newline issues)
const RPC_POLYGON = RPC_RAW.trim();
const WALLET_PRIVATE_KEY = PRIVATE_KEY_RAW.trim();

// Strict validation (no secret output)
if (!RPC_POLYGON) {
  throw new Error("RPC_POLYGON is missing or empty");
}

if (!WALLET_PRIVATE_KEY) {
  throw new Error("WALLET_PRIVATE_KEY is missing or empty");
}

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = 0.03;
const MIN_EXPECTED_PROFIT = 0.000001;
const SLIPPAGE_PCT = 0.05;
const SCAN_DELAY_MS = 8000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xe9068882B5E499Ca3c4ed1EDfd87aA6f7b57C159";

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

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

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

/* ================= CORE LOGIC ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const directPathBuy = [usdc, tokenAddr];
  const directPathSell = [tokenAddr, usdc];

  const buyOut = await quote(buyRouter, amountIn, directPathBuy);
  if (!buyOut) return;

  const sellOut = await quote(sellRouter, buyOut, directPathSell);
  if (!sellOut) return;

  const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));
  const profit = receivedUSDC - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log(`🔥 ARB FOUND | Profit ≈ ${profit.toFixed(6)} USDC`);

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    amountIn,
    directPathBuy,
    directPathSell,
    deadline
  );

  console.log(`⛓ TX SENT: ${tx.hash}`);
  await tx.wait();
  console.log("✅ PROFIT DEPOSITED TO VAULT");
}

/* ================= SCANNER ================= */

async function scan() {
  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        try {
          await tryArb(buy, sell, token);
          await sleep(1200);
        } catch (e) {
          console.log(`⚠️ ${e.message}`);
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

(async () => {
  console.log("🚀 Arbitrage bot started");
  while (true) {
    await scan();
    await sleep(SCAN_DELAY_MS);
  }
})();
