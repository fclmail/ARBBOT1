// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — DRY RUN VERSION
//    (NO REAL TRANSACTIONS, NO GAS USED)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// 🟢 DRY RUN ALWAYS ON – SAFE MODE
const DRY_RUN = true;
console.log(`🧪 DRY RUN MODE ENABLED — NO REAL TRADES WILL BE EXECUTED\n`);


// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // unchanged
const MIN_NET_PROFIT_USDC = 1;

// Provider ONLY (wallet unnecessary in dry run)
const provider = new ethers.JsonRpcProvider(RPC_URL);


// ─────────────── STUB CONTRACT (NO WALLET NEEDED) 🟢2 ───────────────
// Provides read-only access to USDC() + owner()
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

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

(async () => {
  console.log("🏛 Contract Address:", await arbContract.getAddress());
  console.log("👤 Contract Owner:", await arbContract.owner());
})();


// ─────────────── ROUTERS 🟢3 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};


// ─────────────── TOKENS 🟢4 ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};


// ─────────────── SETTINGS 🟢5 ───────────────
const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;


// ─────────────── HELPERS 🟢6 ───────────────
function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      fallback
    );
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}


// ─────────────── CUMULATIVE PROFIT 🟢7 ───────────────
let cumulativeProfit = 0;


// ─────────────── SIMULATED TRADE EXECUTOR 🟢8 ───────────────
// ❗ Safe — No real transactions sent
async function executeTradeSimulated(buyRouter, sellRouter, tokenAddr, amount) {
  console.log("🧪 ---------------------------------------");
  console.log("🧪 DRY RUN — Simulating trade execution");
  console.log("🧪 Buy Router:", buyRouter);
  console.log("🧪 Sell Router:", sellRouter);
  console.log("🧪 Token:", tokenAddr);
  console.log("🧪 AmountIn:", amount);

  // Generate mock profit
  const simulatedProfit = (Math.random() * 0.04).toFixed(6); // 0–4% fake profit
  cumulativeProfit += Number(simulatedProfit);

  console.log(`✅ Simulated Net Profit: ${simulatedProfit} USDC`);
  console.log(`💰 Cumulative Profit: ${cumulativeProfit.toFixed(6)} USDC`);
  console.log("🧪 ---------------------------------------\n");
}



// ─────────────── SCAN LOOP 🟢9 ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...\n");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {

        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct  = (profitUSDC / buyPrice) * 100;

          // Adjust for slippage
          profitUSDC *= 1 - SLIPPAGE_PCT / 100;
          profitPct  *= 1 - SLIPPAGE_PCT / 100;

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ symbol, buyName, sellName });

            console.log(
              `🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`
            );

            // Simulated trade
            await executeTradeSimulated(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (err) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}:`, err.message);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} profitable opportunities.\n`);
  return opportunities;
}



// ─────────────── MAIN LOOP 🟢10 ───────────────
async function main() {
  console.log("🚀 DRY RUN Aave Flash Arbitrage Bot Started\n");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
