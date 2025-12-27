// ---------------------------------------------------------
//  ARBITRAGE BOT – FULL FIXED VERSION (ethers v6 SAFE)
//  - bigint-safe math (NO BigNumber.mul errors)
//  - Color-coded logs
//  - Vault guard, simulation, CSV intact
// ---------------------------------------------------------

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
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
const DRY_RUN = process.env.DRY_RUN !== "false";
console.log(
  DRY_RUN
    ? `${C.cyan}🔬 DRY RUN — NO ON-CHAIN TX${C.reset}`
    : `${C.red}🚀 LIVE MODE ENABLED — REAL TX${C.reset}`
);

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required");

const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.05);
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01);
const MIN_TRADE_USDC = 0.01;
const MAX_PROFIT_PCT = 40;
const VAULT_GUARD_DROP_PCT = 20;

// ---------- ROUTERS ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ---------- TOKENS ----------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ---------- CSV ----------
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, profitPct }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, profitPct].join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","ProfitPct"];
  const file = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(file, [header.join(","), ...csvRows].join("\n"));
  console.log(`${C.green}💾 CSV saved: ${file}${C.reset}`);
}

// ---------- PROVIDER ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- CONTRACT ----------
const arbAbi = [
  "function executeArbitrage(address,address,address,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)"
];

const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  arbAbi,
  wallet || provider
);

// ---------- ERC20 ----------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

let usdcContract;
let usdcDecimals = 6;

// ---------- INIT ----------
async function init() {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
  usdcDecimals = await usdcContract.decimals();
  const owner = await arbContract.owner();

  console.log(`${C.blue}🏛 Vault:${C.reset}`, CONTRACT_ADDRESS);
  console.log(`${C.blue}💵 USDC:${C.reset}`, usdcAddr, `(${usdcDecimals} dec)`);
  console.log(`${C.blue}👤 Owner:${C.reset}`, owner);
}

// ---------- HELPERS ----------
const fmt = (n, d = 6) => Number(n).toFixed(d);

async function getAmountOut(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
    provider
  );
  const usdcAddr = await arbContract.USDC();
  const amountIn = ethers.parseUnits(amountUSDC.toString(), usdcDecimals);

  try {
    const out = await router.getAmountsOut(amountIn, [usdcAddr, token.address]);
    return ethers.formatUnits(out[1], token.decimals);
  } catch {
    const out = await router.getAmountsOut(amountIn, [usdcAddr, tokens.WBTC.address, token.address]);
    return ethers.formatUnits(out[2], token.decimals);
  }
}

// ---------- STATE ----------
let cumulativeProfit = 0;
let vaultGuardActive = true;
let initialVaultBalance = null;

// ---------- CORE ----------
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const ts = new Date().toISOString();
  const token = Object.values(tokens).find(t => t.address === tokenAddr);

  try {
    const beforeBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBN, usdcDecimals));
    if (!initialVaultBalance) initialVaultBalance = before;

    if (vaultGuardActive && before < initialVaultBalance * (1 - VAULT_GUARD_DROP_PCT / 100)) {
      vaultGuardActive = false;
      console.log(`${C.red}⛔ Vault guard triggered — trading stopped${C.reset}`);
      return;
    }

    console.log(`\n${C.gray}────────────────────────────────────${C.reset}`);
    console.log(`${C.blue}🔍 ${ts} | ${tokenAddr}${C.reset}`);
    console.log(`${C.blue}🏦 Vault:${C.reset} ${fmt(before)} USDC`);

    if (!vaultGuardActive || amountUSDC < MIN_TRADE_USDC) return;

    const buyOut = await getAmountOut(buyRouter, token, amountUSDC);
    const sellOut = await getAmountOut(sellRouter, token, amountUSDC);

    // ---------- bigint math ----------
    const buyAmountBN = ethers.parseUnits(amountUSDC.toString(), usdcDecimals);
    const buyOutBN = ethers.parseUnits(buyOut.toString(), token.decimals);
    const sellOutBN = ethers.parseUnits(sellOut.toString(), token.decimals);

    const ONE_TOKEN = 10n ** BigInt(token.decimals);
    const ONE_USDC = 10n ** BigInt(usdcDecimals);

    const buyPrice = (buyAmountBN * ONE_TOKEN) / buyOutBN;
    const sellPrice = (buyAmountBN * ONE_TOKEN) / sellOutBN;

    const profitBN = ((sellPrice - buyPrice) * ONE_USDC) / ONE_TOKEN;
    const profitUSDC = Number(ethers.formatUnits(profitBN, usdcDecimals));
    const profitPct = (profitUSDC / amountUSDC) * 100;

    console.log(`${C.gray}BuyOut:${C.reset}`, buyOut, `SellOut:`, sellOut);

    if (profitPct < MIN_PROFIT_PCT || profitPct > MAX_PROFIT_PCT) {
      console.log(`${C.yellow}⛔ Skip — Profit ${fmt(profitPct)}%${C.reset}`);
      return;
    }

    console.log(
      `${C.green}💎 PROFITABLE OPPORTUNITY${C.reset}\n` +
      `${C.green}💰 Expected Profit:${C.reset} ${fmt(profitUSDC)} USDC\n` +
      `${C.green}📈 Expected %:${C.reset} ${fmt(profitPct)}%`
    );

    // ---------- SIM ----------
    await provider.call({
      to: CONTRACT_ADDRESS,
      data: arbContract.interface.encodeFunctionData(
        "executeArbitrage",
        [buyRouter, sellRouter, tokenAddr, buyAmountBN]
      )
    });

    if (DRY_RUN) {
      console.log(`${C.cyan}🧪 DRY RUN — TX skipped${C.reset}`);
      return;
    }

    const feeData = await provider.getFeeData();
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, buyAmountBN,
      { gasPrice: feeData.gasPrice }
    );

    console.log(`${C.blue}🔁 TX:${C.reset}`, tx.hash);
    const receipt = await tx.wait();

    const afterBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBN, usdcDecimals));
    const netProfit = after - before;
    const netPct = (netProfit / before) * 100;

    console.log(`${C.green}✅ TX CONFIRMED${C.reset}`);
    console.log(`${C.green}💵 REAL PROFIT:${C.reset} ${fmt(netProfit)} USDC`);
    console.log(`${C.green}📊 NET %:${C.reset} ${fmt(netPct)}%`);

    cumulativeProfit += netProfit;

    logTradeCSV({
      timestamp: ts,
      symbol: tokenAddr,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profitUSDC: netProfit,
      profitPct: netPct
    });

  } catch (e) {
    console.error(`${C.red}⚠️ Trade error:${C.reset}`, e.message);
  }
}

// ---------- SCAN ----------
async function scanAllPairs() {
  console.log(`${C.cyan}\n🔄 Scanning all pairs...${C.reset}`);
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await executeTradeLive(buy, sell, token.address, TRADE_AMOUNT_USDC);
        }
      }
    }
  }
  saveCSV();
}

// ---------- MAIN ----------
(async () => {
  await init();
  console.log(`${C.green}🚀 Arbitrage bot started${C.reset}`);
  setInterval(scanAllPairs, 10000);
})();
