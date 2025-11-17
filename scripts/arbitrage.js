// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon
// (SafeSim dry run + flash loan execution)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const MIN_NET_PROFIT_USDC = 1; // Minimum profit after gas

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

// Initialize provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ROUTERS 🟢2 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS 🟢3 ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── SETTINGS 🟢4 ───────────────
const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;
const SCAN_INTERVAL = 30_000; // 30 seconds

// ─────────────── HELPERS 🟢5 ───────────────
function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  // Use USDC address from the flash loan contract
  const usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
  let path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    // fallback path via WBTC
    path = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── CUMULATIVE PROFIT 🟢6 ───────────────
let cumulativeProfit = 0;

// ─────────────── SAFESIM EXECUTION 🟢7 ───────────────
async function safeSimTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const buyOut = await getAmountOut(buyRouter, tokens[tokenAddr], amount);
    const sellOut = await getAmountOut(sellRouter, tokens[tokenAddr], amount);

    const buyPrice = amount / buyOut;
    const sellPrice = amount / sellOut;

    let profitUSDC = sellPrice - buyPrice;
    let profitPct = (profitUSDC / buyPrice) * 100;

    profitUSDC *= (1 - SLIPPAGE_PCT / 100);
    profitPct *= (1 - SLIPPAGE_PCT / 100);

    return { profitUSDC, profitPct, buyPrice, sellPrice };
  } catch (err) {
    console.warn(`⚠️ SafeSim failed: ${err.message}`);
    return null;
  }
}

// ─────────────── FLASH LOAN EXECUTION 🟢8 ───────────────
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
  }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

async function executeFlashLoan(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokens[tokenAddr].address,
      ethers.parseUnits(amount.toString(), 6),
      { gasLimit: 2_000_000 }
    );
    console.log(`⏳ Trade sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined: ${tx.hash} | block ${receipt.blockNumber}`);
  } catch (err) {
    console.error(`⚠️ Flash loan trade failed: ${err.reason || err.message}`);
  }
}

// ─────────────── SCAN LOOP 🟢9 ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        const sim = await safeSimTrade(buyName, sellName, symbol, TRADE_AMOUNT_USDC);
        if (!sim) continue;

        if (sim.profitPct >= MIN_PROFIT_PCT) {
          cumulativeProfit += sim.profitUSDC;
          console.log(
            `🚨 ${symbol} | Buy:${buyName} @ $${fmt(sim.buyPrice)} → Sell:${sellName} @ $${fmt(sim.sellPrice)} | Profit: ${fmt(sim.profitUSDC)} USDC (${fmt(sim.profitPct,2)}%)`
          );
          console.log(`📊 Cumulative simulated profit: ${cumulativeProfit.toFixed(6)} USDC`);

          // Execute real flash loan arbitrage
          await executeFlashLoan(buyRouter, sellRouter, symbol, TRADE_AMOUNT_USDC);
        }
      }
    }
  }
}

// ─────────────── MAIN LOOP 🟢10 ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, SCAN_INTERVAL));
  }
}

main().catch(console.error);
