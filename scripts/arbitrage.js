// ----------------------------------------------------
// AAVE FLASH ARB BOT - POLYGON
// Full arbitrage.js with callStatic simulation, logging, and balances
// ----------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ----------------------------------------------------
// CONFIG
// ----------------------------------------------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // HARDCODED
const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;

// ----------------------------------------------------
// VALIDATE ENV
// ----------------------------------------------------
if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

// ----------------------------------------------------
// PROVIDER & WALLET
// ----------------------------------------------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ----------------------------------------------------
// CONTRACT ABI
// ----------------------------------------------------
const arbAbi = [
  "function executeArbitrage(address buyDex, address sellDex, address token, uint256 amount) external",
  "function USDC() external view returns(address)",
  "function owner() external view returns(address)"
];
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ----------------------------------------------------
// ROUTERS
// ----------------------------------------------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ----------------------------------------------------
// TOKENS
// ----------------------------------------------------
const tokens = {
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------
const norm = (addr) => {
  try { return ethers.getAddress(addr); }
  catch { return null; }
};

function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

async function getUSDCAddress() {
  return await arbContract.USDC();
}

async function getAmountOut(routerAddr, token, amountHumanUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddr = await getUSDCAddress();
  const path = [usdcAddr, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountHumanUSDC.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    return null;
  }
}

async function getWalletMaticBalance() {
  const balance = await provider.getBalance(wallet.address);
  return Number(ethers.formatUnits(balance, 18));
}

async function getContractUSDCBalance() {
  const usdcAddr = await getUSDCAddress();
  const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = await usdc.balanceOf(CONTRACT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

// ----------------------------------------------------
// EXECUTE TRADE WITH CALLSTATIC + LOGGING
// ----------------------------------------------------
async function executeTrade(buyRouter, sellRouter, token, amountHumanUSDC) {
  const buy = norm(buyRouter);
  const sell = norm(sellRouter);
  const tok = norm(token.address);

  if (!buy || !sell || !tok) return { executed: false, reason: "Invalid checksum address" };

  const amountUnits = ethers.parseUnits(amountHumanUSDC.toString(), 6);

  // 1️⃣ callStatic simulation
  try {
    await arbContract.callStatic.executeArbitrage(buy, sell, tok, amountUnits);
    console.log(`✅ callStatic passed for ${token.symbol} | ${buyRouter} -> ${sellRouter}`);
  } catch (err) {
    console.warn(`✖ callStatic would fail: ${err.reason || err.message}`);
    return { executed: false, reason: "callStatic fail" };
  }

  // 2️⃣ Send tx
  console.log(`⏳ Sending arbitrage tx: ${token.symbol} | ${buyRouter} -> ${sellRouter}`);
  const tx = await arbContract.executeArbitrage(buy, sell, tok, amountUnits, { gasLimit: 2_500_000 });
  const receipt = await tx.wait();
  console.log(`✅ Arbitrage success: ${token.symbol} | TxHash: ${receipt.transactionHash}`);

  // 3️⃣ Log balances and net profit
  const contractUSDCBefore = await getContractUSDCBalance();
  const walletMatic = await getWalletMaticBalance();
  const contractUSDCAfter = await getContractUSDCBalance();
  const netProfit = contractUSDCAfter - contractUSDCBefore;

  console.log(`💹 Net profit USDC: ${fmt(netProfit)}`);
  console.log(`🏦 Contract USDC balance: ${fmt(contractUSDCAfter)}`);
  console.log(`🦊 Wallet MATIC balance: ${fmt(walletMatic)}`);

  return { executed: true, hash: receipt.transactionHash, netProfit };
}

// ----------------------------------------------------
// SCAN LOOP
// ----------------------------------------------------
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          if (!buyOut || !sellOut) continue;

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          const profitUSDC = sellPrice - buyPrice;
          const profitPct = (profitUSDC / buyPrice) * 100;

          console.log(`🚨 ${symbol} | Buy:${buyName} @$${fmt(buyPrice)} -> Sell:${sellName} @$${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            await executeTrade(buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
          }
        } catch (err) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${err.message}`);
        }
      }
    }
  }
}

// ----------------------------------------------------
// MAIN LOOP
// ----------------------------------------------------
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  console.log("👤 Contract owner:", await arbContract.owner());
  console.log("🏛 Contract address:", CONTRACT_ADDRESS);
  console.log("💰 Wallet address:", wallet.address);

  while (true) {
    await scan();
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch(console.error);
