// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Full Safe Version)
// Includes callStatic & detailed logging
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Hardcoded
const MIN_NET_PROFIT_USDC = 1;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── CONTRACT ABI 🟢2 ───────────────
const arbAbi = [
  "function executeArbitrage(address buyDex, address sellDex, address token, uint256 amount) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

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
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── SETTINGS 🟢5 ───────────────
const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;

// ─────────────── HELPERS 🟢6 ───────────────
const fmt = (n, dec = 4) => Number(n).toFixed(dec);
const norm = (addr) => {
  try { return ethers.getAddress(addr); } 
  catch { return null; }
};

// ─────────────── GET AMOUNT OUT 🟢7 ───────────────
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
    const path2 = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path2);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── EXECUTE TRADE 🟢8 ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  const buy = norm(buyRouter);
  const sell = norm(sellRouter);
  const tok = norm(tokenAddr);
  if (!buy || !sell || !tok) {
    console.log("⚠️ Invalid checksum address:", buyRouter, sellRouter, tokenAddr);
    return;
  }

  // 1️⃣ CallStatic simulation
  try {
    await arbContract.callStatic.executeArbitrage(buy, sell, tok, ethers.parseUnits(amount.toString(), 6));
    console.log("⏳ callStatic passed: Trade can execute");
  } catch (err) {
    console.log("✖ callStatic would fail:", err.reason || err.message);
    return;
  }

  // 2️⃣ Send TX
  try {
    console.log(`🚀 Executing arbitrage: Token ${tok}, Buy ${buy}, Sell ${sell}`);
    const tx = await arbContract.executeArbitrage(buy, sell, tok, ethers.parseUnits(amount.toString(), 6), { gasLimit: 2500000 });
    const receipt = await tx.wait();
    console.log(`✅ Arbitrage success | TX: ${receipt.transactionHash}`);

    const usdcAddress = await arbContract.USDC();
    const usdc = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);
    const balanceAfter = await usdc.balanceOf(CONTRACT_ADDRESS);
    console.log(`💹 Contract USDC balance: ${ethers.formatUnits(balanceAfter, 6)} USDC`);

    const walletBalance = await provider.getBalance(wallet.address);
    console.log(`📦 Wallet MATIC balance: ${ethers.formatEther(walletBalance)} MATIC`);
  } catch (err) {
    console.log("⚠️ Arbitrage failed:", err.reason || err.message);
  }
}

// ─────────────── SCAN LOOP 🟢9 ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct *= (1 - SLIPPAGE_PCT / 100);

          console.log(`🚨 ${symbol} | Buy:${buyName} @$${fmt(buyPrice)} -> Sell:${sellName} @$${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (err) {
          console.log(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}:`, err.message);
        }
      }
    }
  }
}

// ─────────────── MAIN LOOP 🟢10 ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  console.log("✅ Connected to contract:", await arbContract.getAddress());
  console.log("👤 Contract owner:", await arbContract.owner());
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);

