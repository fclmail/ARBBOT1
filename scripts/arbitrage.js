// arbitrage.js — executes arbitrage only if expected profit > 0.2%

import { ethers, Wallet } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const DRY_RUN = false;
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!DRY_RUN && !PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------------- CONFIG ----------------
const VAULT = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TRADE_AMOUNT = 0.05;         // 0.05 USDC
const PROFIT_TARGET = 0.002;       // 0.2%
const LOOP_DELAY = 4000;

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const tokens = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  CRV:  "0x172370d5Cd63279eFa6d502Dab29171933a610AF"
};

// ---------------- ABI ----------------
const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const vault = new ethers.Contract(
  VAULT,
  vaultAbi,
  DRY_RUN ? provider : wallet
);

// -------- HELPERS --------

async function getUSDC() {
  return await vault.USDC();
}

async function getVaultBal() {
  const usdc = await getUSDC();
  const c = new ethers.Contract(usdc, erc20Abi, provider);
  return await c.balanceOf(VAULT);
}

async function amountsOut(router, path, amountIn) {
  // prevent IDENTICAL_ADDRESSES revert
  if (path[0].toLowerCase() === path[path.length - 1].toLowerCase()) {
    return [amountIn, amountIn];
  }

  const r = new ethers.Contract(router, routerAbi, provider);
  return await r.getAmountsOut(amountIn, path);
}

function requiredReturn(amountFloat) {
  return amountFloat * (1 + PROFIT_TARGET);
}

// -------- CORE LOGIC --------

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await getUSDC();
  const amountInBn = ethers.parseUnits(TRADE_AMOUNT.toString(), 6);

  // STEP 1 — Buy USDC → token
  let buyOut;
  try {
    buyOut = await amountsOut(buyRouter, [usdc, tokenAddr], amountInBn);
  } catch {
    // try fallback path via WBTC
    buyOut = await amountsOut(buyRouter, [usdc, tokens.WBTC, tokenAddr], amountInBn);
  }
  const tokenOut = buyOut[buyOut.length - 1];

  if (tokenOut === 0n) return;

  // STEP 2 — Sell token → USDC
  let sellOut;
  try {
    sellOut = await amountsOut(sellRouter, [tokenAddr, usdc], tokenOut);
  } catch {
    sellOut = await amountsOut(sellRouter, [tokenAddr, tokens.WBTC, usdc], tokenOut);
  }
  const expectedReturnBn = sellOut[sellOut.length - 1];

  const expectedReturnFloat = Number(ethers.formatUnits(expectedReturnBn, 6));
  const requiredFloat = requiredReturn(TRADE_AMOUNT);

  if (expectedReturnFloat < requiredFloat) {
    console.log(
      `💤 Not profitable: expected=${expectedReturnFloat.toFixed(6)} < required=${requiredFloat.toFixed(6)}`
    );
    return;
  }

  // STEP 3 — Calculate safe minReturn for contract call
  // use 0.3% conservative reduction
  const minReturnFloat = expectedReturnFloat * 0.997;
  const minReturnBn = ethers.parseUnits(minReturnFloat.toFixed(6), 6);

  if (DRY_RUN) {
    console.log(`🧪 DRY RUN: Would execute trade | expected: ${expectedReturnFloat}`);
    return;
  }

  // STEP 4 — Simulate before spending gas
  const iface = new ethers.Interface(vaultAbi);
  const data = iface.encodeFunctionData("executeArbitrage", [
    buyRouter,
    sellRouter,
    tokenAddr,
    amountInBn,
    minReturnBn
  ]);

  try {
    await provider.call({ to: VAULT, data, from: wallet.address });
  } catch (e) {
    console.log("❌ Sim failed:", e.message);
    return;
  }

  // STEP 5 — Execute transaction
  try {
    const gas = await provider.estimateGas({ to: VAULT, data, from: wallet.address });
    const tx = await wallet.sendTransaction({ to: VAULT, data, gasLimit: gas * 120n / 100n });

    console.log(`🚀 Arbitrage TX sent! Hash: ${tx.hash}`);

    const receipt = await tx.wait();

    if (receipt.status === 1) {
      console.log(`✅ Arbitrage SUCCESS | block ${receipt.blockNumber}`);
      const after = await getVaultBal();
      console.log(`✔ Vault new balance: ${ethers.formatUnits(after,6)}`);
    } else {
      console.log("❌ Transaction reverted");
    }
  } catch (err) {
    console.log("❌ Send error:", err.message);
  }
}

// -------- LOOP --------

(async () => {
  console.log(`🏛 Vault: ${VAULT}`);
  console.log(`👤 Owner: ${await vault.owner()}`);
  console.log(`💱 USDC: ${await getUSDC()}`);
  console.log(`🚀 Bot started (LIVE)\n`);

  while (true) {
    const bal = Number(ethers.formatUnits(await getVaultBal(), 6));
    if (bal < TRADE_AMOUNT) {
      console.log(`⚠️ Vault balance low: ${bal}`);
      await new Promise(r => setTimeout(r, LOOP_DELAY));
      continue;
    }

    for (const [nameA, R1] of Object.entries(routers)) {
      for (const [nameB, R2] of Object.entries(routers)) {
        if (R1 === R2) continue;

        for (const [symbol, tokenAddr] of Object.entries(tokens)) {
          await tryArb(R1, R2, tokenAddr);
        }
      }
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY));
  }
})();
