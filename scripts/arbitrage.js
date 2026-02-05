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
const SCAN_INTERVAL_MS = 20_000;
const DEADLINE_SECONDS = 60;

/* ================= AUTO WITHDRAW SETTINGS ================= */
/* ===== ONLY SETTINGS ADDED (nothing else changed) ===== */

const AUTO_WITHDRAW_ENABLED = true;
const WITHDRAW_PERCENT_OF_VAULT = 1;     // 1–100 %
const WITHDRAW_THRESHOLD_USDC = 1.2;     // withdraw ONLY if vault ≥ this

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  "function usdc() view returns(address)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"
};

const routerAbi = [
  "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns(uint[])"
];

/* ================= TOKENS ================= */

const TOKENS = {
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

/* ========================================================= */
/* ================= AUTO WITHDRAW FUNCTION ================= */
/* ===== ONLY THRESHOLD CHECK ADDED — NOTHING ELSE ===== */
/* ========================================================= */

async function autoWithdraw(usdcAddr) {
  if (!AUTO_WITHDRAW_ENABLED) return;

  const usdc = new ethers.Contract(
    usdcAddr,
    [
      "function balanceOf(address) view returns(uint256)",
      "function transferFrom(address,address,uint256) returns(bool)",
      "function approve(address,uint256) returns(bool)"
    ],
    wallet
  );

  const router = new ethers.Contract(
    routers.QuickSwap,
    routerAbi,
    wallet
  );

  const vaultBalance = await usdc.balanceOf(VAULT_ADDRESS);

  const thresholdUnits = ethers.parseUnits(
    WITHDRAW_THRESHOLD_USDC.toString(),
    6
  );

  /* ===== THRESHOLD CHECK (only new logic) ===== */
  if (vaultBalance < thresholdUnits) return;

  const percent = BigInt(WITHDRAW_PERCENT_OF_VAULT);
  const amountToSwap = (vaultBalance * percent) / 100n;

  if (amountToSwap === 0n) return;

  console.log(
    `💸 Auto-withdraw triggered | Swapping ${ethers.formatUnits(
      amountToSwap,
      6
    )} USDC (${WITHDRAW_PERCENT_OF_VAULT}% of vault)`
  );

  try {
    const pullTx = await usdc.transferFrom(
      VAULT_ADDRESS,
      wallet.address,
      amountToSwap
    );
    await pullTx.wait();

    const approveTx = await usdc.approve(
      routers.QuickSwap,
      amountToSwap
    );
    await approveTx.wait();

    const path = [usdcAddr, TOKENS.WMATIC];

    const deadline =
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

    const swapTx = await router.swapExactTokensForTokens(
      amountToSwap,
      0,
      path,
      wallet.address,
      deadline
    );

    await swapTx.wait();

    console.log("✅ Swapped USDC → MATIC → Wallet");
  } catch (e) {
    console.log(`⚠️ Auto-withdraw failed: ${e.message}`);
  }
}

/* ================= SCAN LOOP ================= */

async function scan() {
  console.log(`🔍 Scan started @ ${new Date().toISOString()}`);

  const usdc = await vault.usdc();

  await autoWithdraw(usdc);

  await showBalances(usdc);

  await sleep(1000);
}

/* ================= MAIN ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
