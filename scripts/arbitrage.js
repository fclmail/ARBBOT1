// ---------------------------------------------------------
//  ARBITRAGE BOT – MERGED + MEV-RESISTANT (Polygon)
//  - Fast float discovery
//  - BigInt-safe execution (ethers v6)
//  - On-chain simulation logging
//  - Private tx path (MEV-resistant)
// ---------------------------------------------------------

import { ethers, Wallet } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

// ---------- COLORS ----------
const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

// ---------- CONFIG ----------
const RPC_PUBLIC  = process.env.RPC_URL || "https://polygon-rpc.com";
const RPC_PRIVATE = process.env.RPC_PRIVATE || null;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const DRY_RUN = process.env.DRY_RUN === "false";

if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

const MIN_TRADE_USDC = 0.01;
const MIN_EXPECTED_PROFIT = 0.000001;
const MIN_PROFIT_PCT = 0.3;
const MAX_PROFIT_PCT = 400;
const SLIPPAGE_PCT = 0.1;
const SCAN_DELAY_MS = 150;

// ---------- PROVIDERS ----------
const providerPublic  = new ethers.JsonRpcProvider(RPC_PUBLIC);
const providerPrivate = RPC_PRIVATE ? new ethers.JsonRpcProvider(RPC_PRIVATE) : providerPublic;

const wallet = new Wallet(PRIVATE_KEY, providerPrivate);

// ---------- VAULT ----------
const VAULT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)"
];

const vault = new ethers.Contract(VAULT, vaultAbi, wallet);

// ---------- ERC20 ----------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ---------- ROUTERS ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ---------- TOKENS ----------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ---------- STATE ----------
let usdcContract;
let usdcDecimals = 6;
let cumulativeProfit = 0;

// ---------- INIT ----------
async function init() {
  const usdcAddr = await vault.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, providerPublic);
  usdcDecimals = await usdcContract.decimals();
  console.log(`${C.green}🚀 Arbitrage Engine Started${C.reset}`);
}

// ---------- HELPERS ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = (n, d = 6) => Number(n).toFixed(d);

async function quote(router, path, amountIn) {
  const r = new ethers.Contract(
    router,
    ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
    providerPublic
  );
  return r.getAmountsOut(amountIn, path);
}

async function getAmountOut(router, token, amountUSDC) {
  const amountIn = ethers.parseUnits(amountUSDC.toString(), usdcDecimals);
  try {
    const out = await quote(router, [usdcContract.target, token.address], amountIn);
    return Number(ethers.formatUnits(out[1], token.decimals));
  } catch {
    return null;
  }
}

// ---------- CORE ----------
async function executeTrade(buyRouter, sellRouter, token, amountUSDC) {
  const ts = new Date().toISOString();
  const beforeRaw = await usdcContract.balanceOf(VAULT);
  const before = Number(ethers.formatUnits(beforeRaw, usdcDecimals));

  const buyOut = await getAmountOut(buyRouter, token, amountUSDC);
  const sellOut = await getAmountOut(sellRouter, token, amountUSDC);
  if (!buyOut || !sellOut) return;

  // ---------- FLOAT DISCOVERY ----------
  const buyPrice  = amountUSDC / buyOut;
  const sellPrice = amountUSDC / sellOut;
  const expectedProfitUSDC =
    (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
  const expectedProfitPct =
    (expectedProfitUSDC / buyPrice) * 100;

  if (
    expectedProfitUSDC < MIN_EXPECTED_PROFIT ||
    expectedProfitPct < MIN_PROFIT_PCT ||
    expectedProfitPct > MAX_PROFIT_PCT
  ) return;

  console.log(`${C.green}
💎 OPPORTUNITY
Token: ${token.address}
Expected: ${fmt(expectedProfitUSDC)} USDC
Pct: ${fmt(expectedProfitPct)}%
${C.reset}`);

  // ---------- BIGINT PREP ----------
  const amountInBN = ethers.parseUnits(amountUSDC.toString(), usdcDecimals);

  // ---------- SIMULATION ----------
  console.log(`${C.cyan}🧪 Simulation running...${C.reset}`);
  try {
    await providerPublic.call({
      to: VAULT,
      data: vault.interface.encodeFunctionData(
        "executeArbitrage",
        [buyRouter, sellRouter, token.address, amountInBN]
      )
    });
    console.log(`${C.green}✅ Simulation PASSED${C.reset}`);
  } catch {
    console.log(`${C.red}❌ Simulation FAILED${C.reset}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`${C.yellow}🧪 DRY RUN — skipping execution${C.reset}`);
    return;
  }

  // ---------- PRIVATE TX SEND ----------
  const fee = await providerPrivate.getFeeData();
  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    token.address,
    amountInBN,
    { gasPrice: fee.gasPrice }
  );

  console.log(`${C.blue}🔁 TX SENT (private) ${tx.hash}${C.reset}`);
  const receipt = await tx.wait();

  if (!receipt || receipt.status === 0) return;

  const afterRaw = await usdcContract.balanceOf(VAULT);
  const after = Number(ethers.formatUnits(afterRaw, usdcDecimals));
  const realProfit = after - before;
  cumulativeProfit += realProfit;

  console.log(`${C.green}✅ REAL PROFIT ${fmt(realProfit)} USDC${C.reset}`);
}

// ---------- SCANNER ----------
async function scan() {
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await executeTrade(buy, sell, token, MIN_TRADE_USDC);
          await sleep(SCAN_DELAY_MS);
        }
      }
    }
  }
}

// ---------- MAIN ----------
(async () => {
  await init();
  while (true) {
    try {
      await scan();
    } catch (e) {
      console.log(`${C.red}Fatal error: ${e.message}${C.reset}`);
    }
  }
})();
