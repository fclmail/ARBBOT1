// ---------------------------------------------------------
// ARBITRAGE BOT – FULL PRODUCTION VERSION (RESTORED + FIXED)
// ---------------------------------------------------------

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

/* ───────────────────────── CONFIG ───────────────────────── */

const DRY_RUN = process.env.DRY_RUN === "true";
console.log(
  DRY_RUN
    ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS"
    : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED"
);

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

if (!DRY_RUN && !PRIVATE_KEY)
  throw new Error("❌ PRIVATE_KEY required for live mode");

const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.2);
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.02);
const MIN_TRADE_USDC = 0.01;
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);
const MAX_PROFIT_PCT = 40;
const VAULT_GUARD_DROP_PCT = 20;
const SCAN_INTERVAL_MS = 10_000;

/* ───────────────────────── COLORS ───────────────────────── */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/* ───────────────────────── DEXES ───────────────────────── */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ───────────────────────── TOKENS ───────────────────────── */

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

/* ───────────────────────── PROVIDER ───────────────────────── */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

/* ───────────────────────── ABIS ───────────────────────── */

const arbAbi = [
  "function executeArbitrage(address,address,address,uint256)",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"
];

/* ───────────────────────── CONTRACTS ───────────────────────── */

const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  arbAbi,
  DRY_RUN ? provider : wallet
);

let usdcContract;
let usdcDecimals = 6;

/* ───────────────────────── CSV LOGGING ───────────────────────── */

const csvRows = [];
function logCSV(row) {
  csvRows.push(row.join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const file = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(file, csvRows.join("\n"));
  console.log(`💾 CSV exported: ${file}`);
}

/* ───────────────────────── HELPERS ───────────────────────── */

const fmt = (n, d = 6) => Number(n).toFixed(d);

async function quote(router, path, amountIn) {
  const r = new ethers.Contract(router, routerAbi, provider);
  const out = await r.getAmountsOut(amountIn, path);
  return out[out.length - 1];
}

/* ───────────────────────── INIT ───────────────────────── */

async function init() {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
  usdcDecimals = await usdcContract.decimals();

  console.log("🏛 Vault:", CONTRACT_ADDRESS);
  console.log("💵 USDC:", usdcAddr);
  console.log("🔢 USDC Decimals:", usdcDecimals);
}

/* ───────────────────────── CORE ARB ───────────────────────── */

let initialVault = null;
let vaultGuard = true;

async function tryArb(symbol, token, buyName, sellName) {
  const buyRouter = routers[buyName];
  const sellRouter = routers[sellName];
  const amountIn = ethers.parseUnits(
    TRADE_AMOUNT_USDC.toString(),
    usdcDecimals
  );

  const before = Number(
    ethers.formatUnits(
      await usdcContract.balanceOf(CONTRACT_ADDRESS),
      usdcDecimals
    )
  );

  if (!initialVault) initialVault = before;
  if (vaultGuard && before < initialVault * (1 - VAULT_GUARD_DROP_PCT / 100)) {
    vaultGuard = false;
    console.log(`${RED}⚠️ Vault guard triggered — stopping trades${RESET}`);
    return;
  }

  const usdc = await arbContract.USDC();

  let buyOut, sellBack;
  try {
    buyOut = await quote(buyRouter, [usdc, token.address], amountIn);
    sellBack = await quote(sellRouter, [token.address, usdc], buyOut);
  } catch {
    return;
  }

  const profitUSDC =
    Number(ethers.formatUnits(sellBack - amountIn, usdcDecimals));
  const profitPct = (profitUSDC / TRADE_AMOUNT_USDC) * 100;

  console.log(
    `${CYAN}${symbol} | ${buyName} → ${sellName} | Profit ${fmt(profitUSDC)} USDC (${fmt(profitPct)}%)${RESET}`
  );

  if (profitPct < MIN_PROFIT_PCT || profitPct > MAX_PROFIT_PCT) {
    console.log(`${YELLOW}⛔ Skipped — profit threshold${RESET}`);
    return;
  }

  /* ─── SIMULATION ─── */
  try {
    await provider.call({
      to: CONTRACT_ADDRESS,
      data: arbContract.interface.encodeFunctionData(
        "executeArbitrage",
        [buyRouter, sellRouter, token.address, amountIn]
      )
    });
  } catch {
    console.log(`${RED}❌ Simulation reverted${RESET}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`${YELLOW}🧪 DRY RUN — simulated only${RESET}`);
    return;
  }

  /* ─── EXECUTION ─── */
  const tx = await arbContract.executeArbitrage(
    buyRouter,
    sellRouter,
    token.address,
    amountIn
  );

  console.log(`${GREEN}📤 TX SENT:${RESET} ${tx.hash}`);
  const receipt = await tx.wait();

  const after = Number(
    ethers.formatUnits(
      await usdcContract.balanceOf(CONTRACT_ADDRESS),
      usdcDecimals
    )
  );

  const realProfit = after - before;

  console.log(`${GREEN}✅ TX MINED${RESET} | ${tx.hash}`);
  console.log(`${GREEN}💰 REAL PROFIT:${RESET} ${fmt(realProfit)} USDC`);

  logCSV([
    new Date().toISOString(),
    symbol,
    buyName,
    sellName,
    TRADE_AMOUNT_USDC,
    fmt(realProfit),
    fmt((realProfit / before) * 100)
  ]);
}

/* ───────────────────────── SCANNER ───────────────────────── */

async function scan() {
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const buy of Object.keys(routers)) {
      for (const sell of Object.keys(routers)) {
        if (buy === sell) continue;
        await tryArb(symbol, token, buy, sell);
      }
    }
  }
  saveCSV();
}

/* ───────────────────────── MAIN ───────────────────────── */

(async () => {
  await init();
  console.log("🚀 Arbitrage scanner running");

  setInterval(async () => {
    try {
      await scan();
    } catch (e) {
      console.error("Fatal scan error:", e.message);
    }
  }, SCAN_INTERVAL_MS);
})();
