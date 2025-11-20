import fs from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL || !PRIVATE_KEY) {
  throw new Error("Set RPC_URL and PRIVATE_KEY in .env");
}

const ARB_CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const VAULT_ADDRESS = ARB_CONTRACT_ADDRESS; // profits go here

// DEX routers
const ROUTERS = {
  QuickSwapV2: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwapV2: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const TOKENS = {
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
};

// Failsafe settings
const MAX_PRICE_DEVIATION = 0.10; // 10%
const MIN_PROFIT_USDC = 0.01;
const COOLDOWN_MS = 5000;

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ARB Contract ABI (simplified for demo)
const ARB_ABI = [
  "function executeArb(address buyDex, address sellDex, address tokenIn, uint256 amountIn) payable returns (bool)",
  "function getVaultBalance() view returns (uint256)"
];

const arbContract = new ethers.Contract(ARB_CONTRACT_ADDRESS, ARB_ABI, wallet);

// ---------------- CSV LOGGING ----------------
const csvRows = [];
function logTradeCSV(r) {
  csvRows.push([
    r.timestamp,
    r.symbol,
    r.buyRouter,
    r.sellRouter,
    r.amount,
    r.profit
  ].join(","));
}
function saveCSV() {
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const csvContent = [header.join(","), ...csvRows].join("\n");
  const fname = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(fname, csvContent);
  console.log(`💾 CSV saved: ${fname}`);
}

// ---------------- HELPERS ----------------
async function getPrice(router, tokenIn, tokenOut, amountIn) {
  try {
    const r = new ethers.Contract(
      router,
      ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"],
      provider
    );
    const amounts = await r.getAmountsOut(amountIn, [tokenIn, tokenOut]);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], 6)); // assume 6 decimals
  } catch (err) {
    console.log(`❌ Price error @ ${router}:`, err.message);
    return null;
  }
}

async function getVaultBalance() {
  try {
    const raw = await arbContract.getVaultBalance();
    return Number(ethers.formatUnits(raw, 6));
  } catch (e) {
    console.log("⚠ Could not read vault balance:", e.message);
    return null;
  }
}

// ---------------- ARBITRAGE LOGIC ----------------
async function executeTrade(tokenSymbol, buyRouter, sellRouter, amountUSDC) {
  try {
    const vaultBefore = await getVaultBalance();
    if (!vaultBefore) return;

    console.log(`🏦 Vault Before Trade: ${vaultBefore.toFixed(6)} USDC`);

    // simulate callStatic to protect against revert
    await arbContract.callStatic.executeArb(buyRouter, sellRouter, TOKENS[tokenSymbol], ethers.parseUnits(amountUSDC.toString(), 6));

    // execute real trade
    const tx = await arbContract.executeArb(buyRouter, sellRouter, TOKENS[tokenSymbol], ethers.parseUnits(amountUSDC.toString(), 6), { gasLimit: 300000 });
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      console.log("⚠ TX failed on-chain — skipping");
      return;
    }

    const vaultAfter = await getVaultBalance();
    const netProfit = vaultAfter - vaultBefore;

    if (netProfit <= 0) {
      console.log("❌ Vault did not increase — emergency stop");
      return;
    }

    console.log(`✅ Trade successful: ${tokenSymbol} | Net Profit: ${netProfit.toFixed(6)} USDC`);

    logTradeCSV({
      timestamp: new Date().toISOString(),
      symbol: tokenSymbol,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profit: netProfit.toFixed(6)
    });

    saveCSV();

  } catch (err) {
    console.log("⚠ Trade error:", err.message);
    await new Promise(r => setTimeout(r, COOLDOWN_MS));
  }
}

async function scanAndTrade() {
  console.log("---- Checking arbitrage ----");
  for (const [symbol, tokenAddr] of Object.entries(TOKENS)) {
    const amountUSDC = 1000;
    const prices = [];

    for (const [dexName, router] of Object.entries(ROUTERS)) {
      const buyPrice = await getPrice(router, USDC, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6));
      const sellPrice = await getPrice(router, tokenAddr, USDC, ethers.parseUnits(amountUSDC.toString(), 6));
      if (buyPrice && sellPrice) prices.push({ dexName, router, buyPrice, sellPrice });
    }

    if (prices.length < 2) {
      console.log("❌ Skipping due to missing quotes.");
      continue;
    }

    const bestBuy = prices.reduce((a,b) => a.buyPrice < b.buyPrice ? a : b);
    const bestSell = prices.reduce((a,b) => a.sellPrice > b.sellPrice ? a : b);

    const deviation = (bestSell.sellPrice - bestBuy.buyPrice)/bestBuy.buyPrice;
    if (deviation < MAX_PRICE_DEVIATION) {
      console.log(`❌ Price deviation too small (${(deviation*100).toFixed(2)}%)`);
      continue;
    }

    const grossProfit = bestSell.sellPrice - bestBuy.buyPrice;
    if (grossProfit < MIN_PROFIT_USDC) {
      console.log(`❌ Gross profit ${grossProfit.toFixed(6)} < MIN_PROFIT_USDC`);
      continue;
    }

    console.log(`🔍 Candidate: ${symbol} | Buy:${bestBuy.dexName} ${bestBuy.buyPrice.toFixed(6)} -> Sell:${bestSell.dexName} ${bestSell.sellPrice.toFixed(6)} | Raw profit: ${grossProfit.toFixed(6)} USDC`);

    await executeTrade(symbol, bestBuy.router, bestSell.router, amountUSDC);
  }
}

// ---------------- MAIN LOOP ----------------
async function main() {
  console.log("🚀 Live ARBJS bot started");
  while (true) {
    await scanAndTrade();
    await new Promise(r => setTimeout(r, COOLDOWN_MS));
  }
}

main();
