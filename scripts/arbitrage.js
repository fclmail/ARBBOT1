// arbjs_live_continuous.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false;  // LIVE mode
console.log(DRY_RUN ? "🔬 DRY RUN" : "🚀 LIVE MODE — REAL TRADES ENABLED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;  // owner key required
if (!PRIVATE_KEY) throw new Error("❌ PRIVATE_KEY missing. Required for live mode.");

// You already set VAULT_CONTRACT in Actions secrets
const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT;

// ⚠️ IMPORTANT: safe limits for your 0.02 USDC balance
const MIN_TRADE_USDC = 0.01;       // safe small test trade
const MAX_TRADE_USDC = 0.01;       // hard max limit to avoid draining vault
const MIN_EXPECTED_PROFIT = 0;     // allow any non-negative profitable trade
const SLIPPAGE_PCT = 0.20;         // 0.2%

// ---------- ROUTERS ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ---------- TOKENS ----------
const tokens = {
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 }
};

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ---------- CONTRACT ABI ----------
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ---------- HELPERS ----------
function fmt(n, d = 6) { return Number(n).toFixed(d); }

async function getUSDC() {
  const usdcAddress = await arbContract.USDC();
  return new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns (uint256)"], provider);
}

async function getAmountOut(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdc = await arbContract.USDC();
  const path = [usdc, token.address];

  const out = await router.getAmountsOut(
    ethers.parseUnits(amountUSDC.toString(), 6), path
  );

  return Number(ethers.formatUnits(out[1], token.decimals));
}

// ---------- EXECUTION ----------
async function executeArb(buyRouter, sellRouter, token, amountUSDC) {
  console.log(`\n🧪 Checking arbitrage: ${amountUSDC} USDC`);

  const usdc = await getUSDC();
  const before = Number(
    ethers.formatUnits(await usdc.balanceOf(CONTRACT_ADDRESS), 6)
  );

  console.log(`🏦 Vault Before: ${fmt(before)} USDC`);

  if (before < MIN_TRADE_USDC) {
    console.log("⛔ Not enough vault balance");
    return;
  }

  let outBuy = await getAmountOut(buyRouter, token, amountUSDC);
  let outSell = await getAmountOut(sellRouter, token, amountUSDC);

  const buyPrice = amountUSDC / outBuy;
  const sellPrice = amountUSDC / outSell;

  const expectedProfit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);

  console.log(`📈 Expected Profit: ${fmt(expectedProfit)} USDC`);

  if (expectedProfit <= MIN_EXPECTED_PROFIT) {
    console.log("❌ Not profitable");
    return;
  }

  console.log("🚀 Sending LIVE transaction...");
  const tx = await arbContract.executeArbitrage(
    buyRouter,
    sellRouter,
    token.address,
    ethers.parseUnits(amountUSDC.toString(), 6)
  );

  console.log("🔁 TX:", tx.hash);

  const receipt = await tx.wait();
  if (!receipt || receipt.status === 0) {
    console.log("❌ Reverted");
    return;
  }

  const after = Number(
    ethers.formatUnits(await usdc.balanceOf(CONTRACT_ADDRESS), 6)
  );

  const realProfit = after - before;
  console.log(`💰 REAL PROFIT: ${fmt(realProfit)} USDC`);
}

// ---------- CONTINUOUS SCAN ----------
async function scanLoop() {
  console.log("\n🔁 Scanner started — every 30 seconds");

  while (true) {
    try {
      for (const tokenKey of Object.keys(tokens)) {
        const token = tokens[tokenKey];

        await executeArb(
          routers.QuickSwap,
          routers.SushiSwap,
          token,
          MIN_TRADE_USDC
        );
      }
    } catch (err) {
      console.log("❌ Error:", err.message);
    }

    await new Promise(res => setTimeout(res, 30000));
  }
}

// ---------- START ----------
(async () => {
  console.log("🏁 Starting LIVE arbitrage bot\n");
  await scanLoop();
})();
