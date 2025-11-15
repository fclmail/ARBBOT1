// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Full fixed version)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.ARB_CONTRACT;
const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;
const SCAN_INTERVAL_MS = 40_000;
const MIN_NET_PROFIT_USDC = 1;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) throw new Error("❌ Missing PRIVATE_KEY or ARB_CONTRACT");

// ─────────────── PROVIDER & WALLET 🟢2 ───────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── FULL CONTRACT ABI 🟢3 ───────────────
const arbAbi = [
  "function executeArbitrage(address buyDex, address sellDex, address token, uint256 amount) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS 🟢4 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS 🟢5 ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── HELPERS 🟢6 ───────────────
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }
function norm(addr) { try { return ethers.getAddress(addr); } catch { return null; } }

async function getUSDCAddress() {
  return await arbContract.USDC();
}

async function getAmountOut(routerAddr, token, amountHumanUSDC) {
  const usdcAddr = await getUSDCAddress();
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const amountIn = ethers.parseUnits(amountHumanUSDC.toString(), 6);
  const path = [usdcAddr, token.address];
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path2 = [usdcAddr, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(amountIn, path2);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── CUMULATIVE PROFIT TRACKING 🟢7 ───────────────
let cumulativeProfit = 0;

// ─────────────── EXECUTE TRADE WITH CALLSTATIC + LOGGING 🟢8 ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountHumanUSDC) {
  const buy = norm(buyRouter);
  const sell = norm(sellRouter);
  const tok = norm(tokenAddr);
  const amountUnits = ethers.parseUnits(amountHumanUSDC.toString(), 6);

  if (!buy || !sell || !tok) {
    console.warn("⚠️ Invalid checksum address");
    return { executed: false, reason: "Invalid checksum address" };
  }

  try {
    // simulate trade
    await arbContract.callStatic.executeArbitrage(buy, sell, tok, amountUnits);
  } catch (err) {
    console.warn("⚠️ callStatic: Trade WOULD FAIL →", err.reason || err.message);
    return { executed: false, reason: err.reason || err.message };
  }

  try {
    // send tx
    const tx = await arbContract.executeArbitrage(buy, sell, tok, amountUnits, { gasLimit: 2_500_000 });
    const receipt = await tx.wait();

    const usdcAddr = await getUSDCAddress();
    const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns(uint256)"], provider);
    const balanceAfter = await usdc.balanceOf(CONTRACT_ADDRESS);
    const netProfit = ethers.formatUnits(balanceAfter, 6) - amountHumanUSDC;
    cumulativeProfit += netProfit;

    console.log(`✅ Tx mined: ${receipt.transactionHash}`);
    console.log(`💹 Net USDC this tx: ${netProfit.toFixed(6)}`);
    console.log(`📊 Cumulative USDC: ${cumulativeProfit.toFixed(6)}`);
    return { executed: true, hash: receipt.transactionHash };
  } catch (err) {
    console.warn("⚠️ Trade execution error:", err.message);
    return { executed: false, reason: err.message };
  }
}

// ─────────────── SCAN LOOP 🟢9 ───────────────
async function scanOnce(tradeAmount = TRADE_AMOUNT_USDC) {
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];

  for (const [sym, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, tradeAmount);
          const sellOut = await getAmountOut(sellRouter, token, tradeAmount);
          if (!buyOut || !sellOut) continue;

          const buyPrice = tradeAmount / buyOut;
          const sellPrice = tradeAmount / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          if (profitPct >= MIN_PROFIT_PCT && profitUSDC > 0) {
            console.log(`🚨 ${sym} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct, 2)}%)`);
            const result = await executeTrade(buyRouter, sellRouter, token.address, tradeAmount);
            if (!result.executed) console.warn("⚠️ Skipping trade:", result.reason);
            else opportunities.push({ token: sym, buyName, sellName, profitUSDC, profitPct });
          }
        } catch (err) {
          console.warn(`⚠️ Error scanning ${sym} ${buyName}->${sellName}:`, err.message);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP 🟢11 ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scanOnce(TRADE_AMOUNT_USDC);
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(console.error);

