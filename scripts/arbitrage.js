// scripts/arbitrage.js
// =======================================================
// ARB BOT — LOGGING RESTORED (NO LOGIC CHANGES)
// =======================================================

import { ethers, Wallet } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ================= CONFIG =================
const DRY_RUN = process.env.DRY_RUN === "true";
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = process.env.VAULT_CONTRACT;

if (!ethers.isAddress(VAULT_ADDRESS)) {
  throw new Error("❌ Invalid VAULT_CONTRACT");
}
if (!DRY_RUN && !PRIVATE_KEY) {
  throw new Error("❌ PRIVATE_KEY required in LIVE mode");
}

// ================= PROVIDER =================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ================= ROUTERS =================
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

// ================= TOKENS =================
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

// ================= ABIs =================
const arbAbi = [
  "function executeArbitrage(address,address,address,uint256)",
  "function USDC() view returns (address)",
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
];

// ================= CONTRACTS =================
const arb = new ethers.Contract(
  VAULT_ADDRESS,
  arbAbi,
  DRY_RUN ? provider : wallet
);

let USDC;
let usdc;

// ================= INIT =================
async function init() {
  USDC = await arb.USDC();
  usdc = new ethers.Contract(USDC, erc20Abi, provider);

  console.log("🏛 Vault Address:", VAULT_ADDRESS);
  console.log("💵 USDC Address :", USDC);
  console.log(DRY_RUN ? "🔬 DRY RUN MODE" : "🚀 LIVE MODE");
}

// ================= HELPERS =================
const fmt = (n, d = 6) => Number(n).toFixed(d);

async function vaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function getOut(router, amount, path) {
  const r = new ethers.Contract(router, routerAbi, provider);
  const out = await r.getAmountsOut(amount, path);
  return out[out.length - 1];
}

// ================= EXECUTION =================
async function executeTradeLive(buy, sell, token, amountIn) {
  console.log("🚀 Sending arbitrage tx...");
  const tx = await arb.executeArbitrage(buy, sell, token, amountIn);
  console.log("📨 Tx hash:", tx.hash);
  const rcpt = await tx.wait();
  console.log("✅ Tx confirmed:", rcpt.status === 1);
}

// ================= SCANNER =================
async function scanAllPairs() {
  console.log("\n🏦 Vault balance:", fmt(await vaultBalance()), "USDC");
  console.log("🔍 Scanning all tokens & routers...");

  const amountIn = ethers.parseUnits("100", 6);

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [bName, bRouter] of Object.entries(routers)) {
      for (const [sName, sRouter] of Object.entries(routers)) {
        if (bName === sName) continue;

        console.log(`${symbol} | ${bName} → ${sName}`);

        try {
          const buyOut = await getOut(bRouter, amountIn, [USDC, token.address]);
          const sellOut = await getOut(sRouter, buyOut, [token.address, USDC]);

          const profit = sellOut - amountIn;
          const pct = Number(profit) / Number(amountIn) * 100;

          if (profit <= 0n) {
            console.log("🧪 Simulation failed (unprofitable)");
            continue;
          }

          console.log(
            `🧪 Simulation pass | +${fmt(ethers.formatUnits(profit, 6))} USDC (${fmt(pct, 2)}%)`
          );

          if (!DRY_RUN) {
            const before = await vaultBalance();
            await executeTradeLive(bRouter, sRouter, token.address, amountIn);
            const after = await vaultBalance();

            console.log(
              `🏦 Vault change: ${fmt(before)} → ${fmt(after)} USDC`
            );
          }

        } catch (e) {
          console.warn("❌ Route error:", e.reason || e.message);
        }
      }
    }
  }
}

// ================= LOOP =================
(async () => {
  await init();
  setInterval(scanAllPairs, 10_000);
})();
