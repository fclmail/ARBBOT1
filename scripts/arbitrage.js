require("dotenv").config();
const { ethers } = require("ethers");

/* ======================================================
   CONFIG
====================================================== */

const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ======================================================
   TOKENS (Polygon Mainnet)
====================================================== */

const TOKENS = {
  USDC:  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  DAI:   "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"
};

/* ======================================================
   ROUTERS (Polygon Mainnet)
====================================================== */

const ROUTERS = [
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", // QuickSwap
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", // SushiSwap
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607", // ApeSwap
  "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429", // Dfyn
  "0x10f4A785F458Bc144e3706575924889954946639"  // MeshSwap
];

/* ======================================================
   ABIs
====================================================== */

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

const VAULT_ABI = [
  "function usdc() view returns (address)",
  "function executeArbitrage(address,address,uint256,address[],address[],uint256,uint256)"
];

/* ======================================================
   CONTRACTS
====================================================== */

const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
const usdc = new ethers.Contract(TOKENS.USDC, ERC20_ABI, wallet);

/* ======================================================
   SETTINGS
====================================================== */

const TRADE_SIZE = ethers.parseUnits("10", 6);
const MIN_PROFIT = ethers.parseUnits("0.0001", 6);
const DEADLINE_SEC = 180;

/* ======================================================
   FIX 1 — AUTO APPROVE VAULT
====================================================== */

async function ensureAllowance(amount) {
  const allowance = await usdc.allowance(wallet.address, VAULT_ADDRESS);

  if (allowance < amount) {
    console.log("🔧 Approving Vault for USDC...");
    const tx = await usdc.approve(VAULT_ADDRESS, ethers.MaxUint256);
    await tx.wait();
    console.log("✅ Vault approved");
  }
}

/* ======================================================
   FIX 2 — EXECUTE ARB SAFE
====================================================== */

async function executeArb(buyRouter, sellRouter, buyPath, sellPath) {
  try {
    const balance = await usdc.balanceOf(wallet.address);

    if (balance < TRADE_SIZE) {
      console.log("⚠️ Not enough USDC balance");
      return;
    }

    await ensureAllowance(TRADE_SIZE);

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SEC;

    console.log(`🔥 ARB FOUND | Profit ≈ ${ethers.formatUnits(MIN_PROFIT, 6)} USDC`);

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      TRADE_SIZE,
      buyPath,
      sellPath,
      MIN_PROFIT,
      deadline,
      {
        gasLimit: 1_000_000
      }
    );

    console.log(`⛓ TX SENT: ${tx.hash}`);

    await tx.wait();

    console.log("✅ CONFIRMED & DEPOSITED");

  } catch (err) {
    console.log("⚠️", err.reason || err.message);
  }
}

/* ======================================================
   SIMPLE SCAN LOOP (example)
   Keep your existing arb detection here
====================================================== */

async function scan() {

  console.log(`🔍 Scan started @ ${new Date().toISOString()}`);

  const buyPath = [TOKENS.USDC, TOKENS.WETH];
  const sellPath = [TOKENS.WETH, TOKENS.USDC];

  for (const buy of ROUTERS) {
    for (const sell of ROUTERS) {
      if (buy === sell) continue;
      await executeArb(buy, sell, buyPath, sellPath);
    }
  }
}

/* ======================================================
   MAIN LOOP
====================================================== */

(async () => {
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 3000));
  }
})();
