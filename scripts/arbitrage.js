// ArbJS: full arb script for LowRevertArbVault
// Prereqs: ethers, dotenv (for PRIVATE_KEY), Node.js environment

import { ethers } from "ethers";
import 'dotenv/config';

/* ================= CONFIG ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Please set PRIVATE_KEY in env.");

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const TRADE_USDC = 0.03; // USDC amount to trade per arbitrage
const JS_MIN_PROFIT = 0.00002; // minimum USDC profit to trigger (in USDC with 6 decimals)
const SLIPPAGE_BPS = 200;
const INTERVAL = 8000;

/* ================= DEXES ================= */

const DEXES = [
  { name: "QuickSwap", addr: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", addr: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "ApeSwap",   addr: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
];

/* ================= TOKENS ================= */

const TOKENS = [
  { sym:"CRV",  addr:"0x172370d5cd63279efa6d502dab29171933a610af", dec:18 },
  { sym:"LINK", addr:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec:18 },
  { sym:"AAVE", addr:"0xd6df932a45c0f255f85145f286ea0b292b21c90b", dec:18 }
]; // 🚫 WBTC removed (fake liquidity)

/* ================= ABIS ================= */

const ROUTER_ABI = [
  "function getAmountsOut(uint,address[]) view returns (uint[])"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

const VAULT_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)"
];

/* ================= SETUP ================= */

const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);
const usdc  = new ethers.Contract(USDC, ERC20_ABI, wallet); // connect with wallet for approvals

for (const d of DEXES)
  d.router = new ethers.Contract(d.addr, ROUTER_ABI, provider);

/* ================= HELPERS ================= */

const u6 = v => ethers.parseUnits(v.toFixed(6), 6);
const f6 = v => Number(ethers.formatUnits(v, 6));
const applySlip = v => v * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n;

let EXECUTING = false;

/* ================= SCAN ================= */

async function scan() {
  if (EXECUTING) return;

  const vaultBal = f6(await usdc.balanceOf(VAULT));

  for (const t of TOKENS) {
    for (const buy of DEXES) {
      for (const sell of DEXES) {
        if (buy === sell) continue;

        try {
          // BUY SIM (USDC -> token)
          const buyOut = await buy.router.getAmountsOut(
            u6(TRADE_USDC),
            [USDC, t.addr]
          );

          const tokenRaw = buyOut[1];
          if (tokenRaw === 0n) continue;

          const tokenNorm = Number(
            ethers.formatUnits(tokenRaw, t.dec)
          );
          if (tokenNorm < 1e-6) continue;

          // SELL SIM (token -> USDC)
          const sellOut = await sell.router.getAmountsOut(
            tokenRaw,
            [t.addr, USDC]
          );

          const usdcRaw = sellOut[1];
          const usdcNorm = f6(usdcRaw);

          const profit = usdcNorm - TRADE_USDC;

          console.log(
            `[SIM] ${t.sym} ${buy.name}→${sell.name} | buy:${tokenNorm.toFixed(6)} sell:${usdcNorm.toFixed(6)} profit:${profit.toFixed(6)} | vault:${vaultBal.toFixed(4)}`
          );

          if (profit < JS_MIN_PROFIT) continue;

          console.log(`✔ SIM PASSED`, "\x1b[32m");

          // Ensure USDC allowance for vault (optional safety)
          // Some vaults pull USDC themselves; if not, uncomment approve pattern:
          // const allowance = await usdc.allowance(wallet.address, VAULT);
          // if (allowance.lt(u6(TRADE_USDC))) {
          //   const approveTx = await usdc.approve(VAULT, ethers.constants.MaxUint256);
          //   await approveTx.wait();
          // }

          EXECUTING = true;

          const before = f6(await usdc.balanceOf(VAULT));
          const deadline = Math.floor(Date.now()/1000) + 120;

          console.log(`🟢 EXECUTING ${t.sym} | buy: ${buy.name} sell: ${sell.name}`);

          // Execute arbitrage on the vault
          const tx = await vault.executeArbitrage(
            buy.addr,
            sell.addr,
            t.addr,
            u6(TRADE_USDC),
            applySlip(tokenRaw),
            applySlip(usdcRaw),
            deadline
          );

          console.log(`📤 TX SENT ${tx.hash}`);
          await tx.wait();

          const after = f6(await usdc.balanceOf(VAULT));

          console.log(`✅ TX CONFIRMED`, "\x1b[32m");
          console.log(`💰 Vault +${(after-before).toFixed(6)} USDC`, "\x1b[32m");

          EXECUTING = false;
          return;

        } catch (e) {
          EXECUTING = false;
          const msg = e?.reason ?? e?.message ?? String(e);
          console.error("❌ EXEC FAIL:", msg);
        }
      }
    }
  }
}

console.log("🚀 Arb bot live");
setInterval(scan, INTERVAL);
