// 🟢1 FILE PURPOSE
// scripts/arbitrage.js

import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_RAW =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const PRIVATE_KEY_RAW =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

const RPC_POLYGON = RPC_RAW.trim();
const WALLET_PRIVATE_KEY = PRIVATE_KEY_RAW.trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON is missing or empty");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is missing or empty");

/* ================= CONSTANTS (UNCHANGED) ================= */

const MIN_TRADE_USDC = 1.7;
const MIN_EXPECTED_PROFIT = 0.0000001;
const SLIPPAGE_PCT = 0.05;
const SCAN_INTERVAL_MS = 1_000;
const DEADLINE_SECONDS = 60;

/* ================= NEW WITHDRAW SETTINGS (ONLY ADDITION) ================= */

const WITHDRAW_THRESHOLD_USDC = 1.7; // change this freely
const WITHDRAW_PERCENT = 5; // 1–100

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  {
    inputs: [
      { type: "address", name: "buyRouter" },
      { type: "address", name: "sellRouter" },
      { type: "uint256", name: "amountInUSDC" },
      { type: "address[]", name: "pathToToken" },
      { type: "address[]", name: "pathToUSDC" },
      { type: "uint256", name: "deadline" }
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
  },
  {
    inputs: [
      { type: "address", name: "tokenAddr" },
      { type: "uint256", name: "amount" }
    ],
    name: "withdrawERC20",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= BALANCE DISPLAY ================= */

async function showBalances(usdcAddr) {
  const maticBal = await provider.getBalance(wallet.address);

  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );

  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

  console.log(
    `💰 Wallet MATIC: ${ethers.formatEther(maticBal)} | Vault USDC: ${Number(
      ethers.formatUnits(vaultBal, 6)
    ).toFixed(6)}`
  );
}

/* ================= FIXED AUTO WITHDRAW ================= */
/* ONLY SECTION ADDED / FIXED */

async function autoWithdraw(usdcAddr) {
  const usdc = new ethers.Contract(
    usdcAddr,
    [
      "function balanceOf(address) view returns(uint256)",
      "function approve(address,uint256)"
    ],
    wallet
  );

  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  const balFloat = Number(ethers.formatUnits(bal, 6));

  if (balFloat < WITHDRAW_THRESHOLD_USDC) return;

  const pct = Math.min(Math.max(WITHDRAW_PERCENT, 1), 100);

  const amount = (bal * BigInt(pct)) / 100n;

  console.log(
    `💸 Auto-withdraw triggered | Swapping ${Number(
      ethers.formatUnits(amount, 6)
    ).toFixed(6)} USDC (${pct}% of vault)`
  );

  try {
    /* STEP 1: vault PUSHES USDC (correct fix) */
    const tx1 = await vault.withdrawERC20(usdcAddr, amount);
    await tx1.wait();

    /* STEP 2: approve router */
    const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);

    const tx2 = await usdc.approve(routers.QuickSwap, amount);
    await tx2.wait();

    /* STEP 3: swap USDC → WMATIC */
    const deadline = Math.floor(Date.now() / 1000) + 120;

    const tx3 = await router.swapExactTokensForTokens(
      amount,
      0,
      [usdcAddr, TOKENS.WMATIC],
      wallet.address,
      deadline
    );

    await tx3.wait();

    console.log("✅ USDC swapped → MATIC and sent to wallet");
  } catch (e) {
    console.log(`⚠️ Auto-withdraw failed: ${e.message}`);
  }
}

/* ================= SCANNER ================= */

async function scan() {
  console.log(`🔍 Scan started @ ${new Date().toISOString()}`);

  const usdc = await vault.usdc();

  await autoWithdraw(usdc);

  await showBalances(usdc);

  await sleep(100);
}

/* ================= MAIN ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
