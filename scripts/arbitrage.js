import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// 🔹 DRY_RUN toggle: simulate only if true
const DRY_RUN = false;

console.log(`🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED\n`);

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Vault
const MIN_PROFIT_USDC = 0.001;

// Provider + signer
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ─────────────── CONTRACT ABI ───────────────
const arbAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function owner() view returns (address)",
  "function USDC() view returns (address)",
  "function minProfit() view returns (uint256)"
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
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
const TRADE_AMOUNT_USDC = 0.001;
const MIN_PROFIT_PCT = 0.5;
const SLIPPAGE_PCT = 0.2;

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) { return Number(n).toFixed(dec); }

let cumulativeProfit = 0;
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profit].join(","));
}
function saveCSV() {
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const csvContent = [header.join(","), ...csvRows].join("\n");
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, csvContent);
  console.log(`💾 Trades exported to CSV: ${filename}`);
}

// ERC20 helpers
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

let usdcContract;
(async () => {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
})();

async function getAmountOut(routerAddr, token, amountInUSDC) {
  try {
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn,address[] memory path) view returns (uint[] memory)"],
      provider
    );
    const usdcAddr = await arbContract.USDC();
    const path = [usdcAddr, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    return 0;
  }
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amount) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { decimals: 18 };

  try {
    // Vault balance before
    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));

    // ✅ simulate callStatic before sending real tx
    const contractWithSigner = arbContract.connect(wallet);
    const amountInWei = ethers.parseUnits(amount.toString(), 6);
    try {
      await contractWithSigner.callStatic.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, amountInWei
      );
    } catch (err) {
      console.log(`❌ callStatic failed — abort trade: ${err.message}`);
      return;
    }

    // Estimate profit using router quotes
    const buyOut = await getAmountOut(buyRouter, tokenObj, amount);
    const sellOut = await getAmountOut(sellRouter, tokenObj, amount);
    if (!buyOut || !sellOut) return;

    const buyPrice  = amount / buyOut;
    const sellPrice = amount / sellOut;
    let expectedProfit = (sellPrice - buyPrice) * amount;
    expectedProfit *= (1 - SLIPPAGE_PCT / 100);

    if (expectedProfit < MIN_PROFIT_USDC) {
      console.log(`❌ Trade rejected — estimated profit ${expectedProfit.toFixed(6)} USDC < MIN_PROFIT`);
      return;
    }

    if (DRY_RUN) {
      console.log(`💤 DRY_RUN: would execute trade ${tokenAddr} ${buyRouter}→${sellRouter} profit ${expectedProfit.toFixed(6)} USDC`);
      return;
    }

    // Execute real tx
    const tx = await contractWithSigner.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, amountInWei,
      { gasLimit: 900_000 }
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ Transaction reverted — vault unchanged");
      return;
    }
    console.log(`✅ Trade executed: txHash ${receipt.transactionHash}`);

    // Vault balance after
    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    if (after <= before) {
      console.log("❌ Trade resulted in no increase — vault unchanged");
      return;
    }

    const netProfit = after - before;
    cumulativeProfit += netProfit;
    console.log(`💰 Real Net Profit: ${netProfit.toFixed(6)} USDC | Cumulative: ${cumulativeProfit.toFixed(6)} USDC`);

    // Log to CSV
    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase()===tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({
      timestamp,
      symbol,
      buyRouter,
      sellRouter,
      amount,
      profit: netProfit
    });

  } catch (err) {
    console.error(`⚠️ Trade failed: ${err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
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
          if (!buyOut || !sellOut) continue;

          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = (sellPrice - buyPrice) * TRADE_AMOUNT_USDC;
          let profitPct  = (profitUSDC / buyPrice) * 100;
          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct  *= (1 - SLIPPAGE_PCT / 100);

          console.log(`${symbol} | ${buyName} $${fmt(buyPrice)} → ${sellName} $${fmt(sellPrice)} | Est. Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 PROFITABLE: executing ${symbol} ${buyName}→${sellName}`);
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
            opportunities.push({ symbol, buyName, sellName });
          }

        } catch (err) {
          console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}:`, err.message);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Opportunities found: ${opportunities.length}\n`);
  saveCSV();
  return opportunities;
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Live Aave Flash Arbitrage Bot with Vault Started\n");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
