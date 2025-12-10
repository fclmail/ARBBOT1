//🟢✅ ARB8 FULL LIVE ARBITRAGE — PROFIT-SAFE
// Updated: vault-only increase, negative trades skipped, Fix #1 + #3 kept

import { ethers, Wallet } from "ethers";
import fs from "fs";

// ---------- CONFIG ----------
const DRY_RUN = false; // 🚀 LIVE TRADES
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

// Hardcoded Polygon RPC + Vault Contract
const RPC_URL = "https://polygon-rpc.com"; 
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // stored in secrets

if (!PRIVATE_KEY && !DRY_RUN) throw new Error("PRIVATE_KEY required for live mode");

// Trading thresholds
const MIN_PROFIT_PCT = 20;        // minimum profit %
const MIN_TRADE_USDC = 0.01;      // min trade size
const MIN_EXPECTED_PROFIT = 0.001; // min profit in USDC
const SLIPPAGE_PCT = 0.0;
const MAX_PROFIT_PCT = 40;
const TRADE_AMOUNT_USDC = 0.01;

// Routers and Tokens
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------
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
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
  } catch (e) {
    console.warn("⚠️ Initialization warning:", e.message);
  }
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }
const colors = { reset:"\x1b[0m", red:"\x1b[31m", green:"\x1b[32m", yellow:"\x1b[33m", cyan:"\x1b[36m" };

function isV3RouterByName(name) {
  if (!name) return false;
  const s = name.toLowerCase();
  return s.includes("v3") || s.includes("uniswapv3") || s.includes("quickswapv3");
}

const BASE_FALLBACKS = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

async function safeGetAmountOut(routerName, routerAddr, token, amountUSDC) {
  try {
    const providerRouter = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
      provider
    );

    const usdcAddrFromContract = await arbContract.USDC();
    const bases = [usdcAddrFromContract, ...BASE_FALLBACKS.filter(b => b.toLowerCase() !== usdcAddrFromContract.toLowerCase())];

    for (const base of bases) {
      try {
        const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
        const path = [base, token.address];
        const amounts = await providerRouter.getAmountsOut(amountInRaw, path);
        const tokenOutHuman = Number(ethers.formatUnits(amounts[1], token.decimals));
        return tokenOutHuman;
      } catch (errV2) {
        if (isV3RouterByName(routerName)) {
          try {
            const quoterAbi = [
              "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
            ];
            const quoter = new ethers.Contract(routerAddr, quoterAbi, provider);
            const amountOutRaw = await quoter.quoteExactInputSingle(
              base, token.address, 3000, ethers.parseUnits(amountUSDC.toString(), 6), 0
            );
            const tokenOutHuman = Number(ethers.formatUnits(amountOutRaw, token.decimals));
            return tokenOutHuman;
          } catch { continue; }
        } else { continue; }
      }
    }

    console.log(`${colors.yellow}⚠️ ${token.address} | Router ${routerAddr} quote failed, skipping${colors.reset}`);
    return null;

  } catch (err) {
    console.log(`${colors.yellow}⚠️ ${token.address} | Router ${routerAddr} quote failed (outer), skipping${colors.reset}`);
    return null;
  }
}

// ---------- CORE TRADE EXECUTION ----------
async function executeTradeLive(buyRouterName, buyRouterAddr, sellRouterName, sellRouterAddr, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };

  try {
    if (amountUSDC < MIN_TRADE_USDC) return;

    const buyOut = await safeGetAmountOut(buyRouterName, buyRouterAddr, tokenObj, amountUSDC);
    const sellOut = await safeGetAmountOut(sellRouterName, sellRouterAddr, tokenObj, amountUSDC);
    if (buyOut === null || sellOut === null) return;

    const expectedProfitUSDC = amountUSDC * (sellOut / buyOut - 1);
    if (expectedProfitUSDC < MIN_EXPECTED_PROFIT) {
      console.log(`${colors.yellow}⚠️ Skipping trade ${tokenAddr} — expected profit too low${colors.reset}`);
      return;
    }

    console.log(`${colors.green}${tokenAddr} | Expected Profit: ${fmt(expectedProfitUSDC)} USDC${colors.reset}`);

    if (DRY_RUN) {
      console.log(`${colors.cyan}[DRY RUN] Would execute: ${buyRouterName} -> ${sellRouterName} amount ${amountUSDC} USDC${colors.reset}`);
      return;
    }

    const tx = await arbContract.executeArbitrage(
      buyRouterAddr, sellRouterAddr, tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6)
    );
    console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      console.log(`${colors.red}❌ TX failed${colors.reset}`);
    } else {
      console.log(`${colors.green}💰 Trade executed — profit stored in vault${colors.reset}`);
      logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter: buyRouterName, sellRouter: sellRouterName, amount: amountUSDC, profitUSDC: expectedProfitUSDC });
    }

  } catch (err) {
    console.log(`${colors.red}⚠️ Unexpected trade error: ${err.message}${colors.reset}`);
  }
}

// ---------- SCAN LOOP ----------
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await safeGetAmountOut(buyName, buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await safeGetAmountOut(sellName, sellRouter, token, TRADE_AMOUNT_USDC);
          if (buyOut === null || sellOut === null) continue;

          const expectedProfitUSDC = TRADE_AMOUNT_USDC * (sellOut / buyOut - 1);
          const expectedProfitPct = (expectedProfitUSDC / TRADE_AMOUNT_USDC) * 100;

          if (expectedProfitUSDC > 0) {
            console.log(`${colors.green}${symbol} | ${buyName}→${sellName} | expected profit=${fmt(expectedProfitUSDC)} USDC | profitPct=${fmt(expectedProfitPct)}%${colors.reset}`);
          } else {
            console.log(`${colors.red}${symbol} | ${buyName}→${sellName} | expected loss skipped${colors.reset}`);
          }

          if (expectedProfitUSDC >= MIN_EXPECTED_PROFIT) {
            await executeTradeLive(buyName, buyRouter, sellName, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.log(`${colors.yellow}${symbol} | ${buyName}→${sellName} | scan error: ${e.message}${colors.reset}`);
        }
      }
    }
  }
  saveCSV();
}

// ---------- MAIN ----------
(async function main() {
  await init();
  console.log("🚀 Live arbitrage runner started");

  setInterval(async () => {
    try { await scanAllPairs(); }
    catch (e) { console.log(`${colors.red}Fatal scanner error: ${e.message}${colors.reset}`); }
  }, 10000);
})();
