// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – VAULT VERSION (BIGINT SAFE)
//  - Continuous scan
//  - Correct quotes
//  - BigInt-only math (ethers v6 safe)
//  - Slippage protected
//  - Vault custody enforced
//  - Router approvals supported
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* ===================== GLOBAL SAFETY NET ===================== */
process.on("unhandledRejection", (r) =>
  console.log("⚠️ Unhandled rejection:", r?.message || r)
);
process.on("uncaughtException", (e) =>
  console.log("⚠️ Uncaught exception:", e.message)
);
/* ============================================================= */

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE KEY");

const DRY_RUN = false;
const RUN_APPROVALS_ONCE = false; // 👈 set true ONCE, then back to false

const MIN_TRADE_USDC = 0.01;
const MIN_EXPECTED_PROFIT = 0.00001; // 10 units (6 decimals)
const MIN_PROFIT_PCT = 0.3;
const SLIPPAGE_PCT = 0.5;
const MAX_PROFIT_PCT = 100;

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ----------------- PROVIDER / WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- ADDRESSES -----------------
const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ----------------- TOKENS -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

// ----------------- ROUTERS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

// ----------------- ABIs -----------------
const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function approveRouter(address,address)",
  "function USDC() view returns (address)",
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])",
];

// ----------------- CONTRACTS -----------------
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);
const usdc = new ethers.Contract(USDC, erc20Abi, provider);

// ----------------- HELPERS -----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function applySlippage(amountBN, pct) {
  return (amountBN * BigInt(10000 - Math.floor(pct * 100))) / 10000n;
}

async function vaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

// ----------------- ONE-TIME APPROVAL SETUP -----------------
async function setupApprovals() {
  console.log(`${colors.cyan}🔐 Running router approvals...${colors.reset}`);

  const routerList = Object.values(routers);
  const tokenList = [USDC, ...Object.values(tokens).map(t => t.address)];

  for (const r of routerList) {
    for (const t of tokenList) {
      const token = new ethers.Contract(t, erc20Abi, provider);
      const allowance = await token.allowance(VAULT_ADDRESS, r);
      if (allowance > 0n) continue;

      const tx = await vault.approveRouter(r, t);
      await tx.wait();
      console.log(`${colors.green}✅ Approved ${t} on ${r}${colors.reset}`);
    }
  }

  console.log(`${colors.green}🎉 All approvals complete${colors.reset}`);
}

// ----------------- EXECUTION -----------------
async function executeTrade(buyRouter, sellRouter, token, amountUSDC) {
  try {
    const before = await vaultBalance();
    console.log(`${colors.cyan}🏦 Vault: ${fmt(before)} USDC${colors.reset}`);
    if (before < amountUSDC) return;

    const usdcIn = ethers.parseUnits(amountUSDC.toString(), 6);
    const buy = new ethers.Contract(buyRouter, routerAbi, provider);
    const sell = new ethers.Contract(sellRouter, routerAbi, provider);

    const tokenOutBN = (await buy.getAmountsOut(
      usdcIn,
      [USDC, token.address]
    ))[1];

    const usdcOutBN = (await sell.getAmountsOut(
      tokenOutBN,
      [token.address, USDC]
    ))[1];

    const profitBN = usdcOutBN - usdcIn;
    if (profitBN <= 0n) return;

    const profit = Number(ethers.formatUnits(profitBN, 6));
    const pct = (profit / amountUSDC) * 100;

    console.log(
      `${colors.magenta}🛒 Buy ${fmt(ethers.formatUnits(tokenOutBN, token.decimals))} @ ${buyRouter.slice(0,6)}${colors.reset}`
    );
    console.log(
      `${colors.magenta}💱 Sell ${fmt(ethers.formatUnits(usdcOutBN, 6))} USDC @ ${sellRouter.slice(0,6)}${colors.reset}`
    );

    if (
      profit < MIN_EXPECTED_PROFIT ||
      pct < MIN_PROFIT_PCT ||
      pct > MAX_PROFIT_PCT
    ) {
      console.log(`${colors.yellow}⚠️ Profit too low${colors.reset}`);
      return;
    }

    console.log(
      `${colors.green}💰 PROFIT: ${fmt(profit)} USDC (${fmt(pct)}%)${colors.reset}`
    );

    if (DRY_RUN) return;

    const minTokenOut = applySlippage(tokenOutBN, SLIPPAGE_PCT);
    const minUSDCOut  = applySlippage(usdcOutBN, SLIPPAGE_PCT);

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      usdcIn,
      minTokenOut,
      minUSDCOut,
      Math.floor(Date.now() / 1000) + 120
    );

    console.log(`${colors.green}🔁 TX SENT: ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      const after = await vaultBalance();
      console.log(
        `${colors.green}✅ VAULT PROFIT: ${fmt(after - before)} USDC${colors.reset}`
      );
    }
  } catch (e) {
    console.log(`${colors.red}⚠️ Trade error: ${e.reason || e.message}${colors.reset}`);
  }
}

// ----------------- SCANNER -----------------
async function scan() {
  console.log("\n🔍 Scanning...");
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await executeTrade(buy, sell, token, MIN_TRADE_USDC);
        await sleep(800);
      }
    }
  }
}

// ----------------- MAIN -----------------
(async () => {
  console.log(`${colors.cyan}🚀 Arb bot running${colors.reset}`);

  if (RUN_APPROVALS_ONCE) {
    await setupApprovals();
    process.exit(0);
  }

  while (true) {
    await scan();
    await sleep(8000);
  }
})();
