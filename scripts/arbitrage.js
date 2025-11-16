// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Dry Run + CallStatic Safe)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; 
const MIN_NET_PROFIT_USDC = 1;

// Safety check
if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

// ─────────────── PROVIDER & WALLET ───────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── CONTRACT ABI ───────────────
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

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    // fallback: USDC → WBTC → token
    try {
      const path2 = [usdcAddress, tokens.WBTC.address, token.address];
      const amounts2 = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path2);
      return Number(ethers.formatUnits(amounts2[amounts2.length - 1], token.decimals));
    } catch (e) {
      console.warn(`⚠️ getAmountsOut failed for token ${token.address}: ${e.message}`);
      return 0;
    }
  }
}

// ─────────────── CUMULATIVE PROFIT ───────────────
let cumulativeProfit = 0;

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, token, amount) {
  let canExecute = false;

  // Call static to simulate trade
  try {
    await arbContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amount.toString(), 6)
    );
    canExecute = true;
  } catch (err) {
    console.warn(`⚠️ Trade skipped (callStatic failed): ${err.reason || err.message}`);
  }

  if (!canExecute) return;

  // Execute actual arbitrage
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amount.toString(), 6),
      { gasLimit: 2_000_000 }
    );
    console.log(`⏳ Trade sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined: ${tx.hash} | block ${receipt.blockNumber}`);

    // Update cumulative profit
    const usdcAddress = await arbContract.USDC();
    const usdc = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns (uint256)"], provider);
    const balanceAfter = await usdc.balanceOf(CONTRACT_ADDRESS);
    const netProfit = ethers.formatUnits(balanceAfter, 6) - amount;
    cumulativeProfit += netProfit;
    console.log(`💹 Net USDC this tx: ${netProfit.toFixed(6)} | Cumulative: ${cumulativeProfit.toFixed(6)}`);
  } catch (err) {
    console.error(`❌ Trade execution failed: ${err.reason || err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          if (buyOut === 0 || sellOut === 0) continue;

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct *= (1 - SLIPPAGE_PCT / 100);

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ token: symbol, buyName, sellName, profitUSDC, profitPct });
            console.log(`🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
