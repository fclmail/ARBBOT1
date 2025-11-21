// 🔹 AAVE FLASH ARB BOT — LIVE VERSION WITH VAULT DEPOSIT
//    All failsafes integrated: MAX_PRICE_DELTA, callStatic, gas guard, vault checks, cooldown, slippage, min profit
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// DRY_RUN toggle: true = simulation only, false = live
const DRY_RUN = false;
console.log(`🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED\n`);

// ───────────── CONFIG ─────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; 
const TRADE_AMOUNT_USDC = 0.001; // amount per trade
const MIN_NET_PROFIT_USDC = 0.0001; // minimal net profit threshold
const MIN_PROFIT_PCT = 0.5;
const SLIPPAGE_PCT = 0.2;
const MAX_PRICE_DELTA = 0.05; // max 5% price deviation
const COOLDOWN_MS = 10000; // cooldown on failed/revert

// Provider + Signer
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ───────────── CONTRACT ─────────────
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

// ───────────── ROUTERS ─────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ───────────── TOKENS ─────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ───────────── ERC20 USDC ─────────────
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];
let usdcContract;
(async () => {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
})();

// ───────────── CSV LOGGING ─────────────
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

// ───────────── HELPERS ─────────────
function fmt(n, dec=4){return Number(n).toFixed(dec);}
let cumulativeProfit = 0;

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddr = await arbContract.USDC();
  const path = [usdcAddr, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    // fallback via WBTC
    const fallback = [usdcAddr, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), fallback);
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

// ───────────── TRADE EXECUTOR ─────────────
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amount) {
  const timestamp = new Date().toISOString();

  // 1️⃣ Vault before
  const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const before = Number(ethers.formatUnits(beforeBal, 6));

  // 2️⃣ CallStatic / simulation guard
  try {
    await arbContract.callStatic.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
    );
  } catch (simErr) {
    console.log(`❌ callStatic failed — abort trade: ${simErr.message}`);
    await new Promise(r => setTimeout(r, COOLDOWN_MS));
    return;
  }

  // 3️⃣ JS pre-profit check
  const tokenObj = Object.values(tokens).find(t=>t.address.toLowerCase()===tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  let buyOut, sellOut;
  try {
    buyOut = await getAmountOut(buyRouter, tokenObj, amount);
    sellOut = await getAmountOut(sellRouter, tokenObj, amount);
  } catch { console.log("❌ Price query failed"); return; }

  const buyPrice = amount / buyOut;
  const sellPrice = amount / sellOut;
  let expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
  if (expectedProfitUSDC < MIN_NET_PROFIT_USDC) {
    console.log(`❌ Profit below threshold after slippage: ${expectedProfitUSDC}`); return;
  }

  // 4️⃣ Gas cost check
  const gasEstimate = await arbContract.estimateGas.executeArbitrage(
    buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
  );
  const gasPrice = await provider.getGasPrice();
  const gasCostUSDC = Number(ethers.formatUnits(gasEstimate.mul(gasPrice), 6));
  if (gasCostUSDC > expectedProfitUSDC) {
    console.log(`❌ Gas cost ${gasCostUSDC} USDC > expected profit ${expectedProfitUSDC} — abort`);
    return;
  }

  // 5️⃣ Execute TX
  if (!DRY_RUN) {
    try {
      const tx = await arbContract.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
      );
      const receipt = await tx.wait();
      if (!receipt || receipt.status===0 || !receipt.transactionHash) {
        console.log("❌ Transaction failed — vault unchanged"); return;
      }
    } catch (err) {
      console.log(`❌ TX failed: ${err.message}`); await new Promise(r=>setTimeout(r, COOLDOWN_MS)); return;
    }
  }

  // 6️⃣ Vault after
  const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const after = Number(ethers.formatUnits(afterBal, 6));
  if (after <= before) { console.log("❌ Vault did not increase — trade ignored"); return; }

  // 7️⃣ Real net profit & logging
  const netProfit = after - before;
  cumulativeProfit += netProfit;
  console.log(`✅ Trade successful: ${tokenAddr} | Net Profit: ${netProfit.toFixed(6)} USDC | Cumulative: ${cumulativeProfit.toFixed(6)} USDC`);

  // CSV logging
  const symbolEntry = Object.entries(tokens).find(([k,t])=>t.address.toLowerCase()===tokenAddr.toLowerCase());
  const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
  logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit: netProfit });
}

// ───────────── SCAN LOOP ─────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  const opportunities = [];
  let buyOutPrev = {};

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          let buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          let sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          if (buyOut===0 || sellOut===0) continue;

          // 1️⃣ Price deviation guard
          const lastBuy = buyOutPrev?.[buyName]?.[symbol] || buyOut;
          const delta = Math.abs(buyOut - lastBuy)/lastBuy;
          if (delta > MAX_PRICE_DELTA) { console.log(`❌ Price deviation too large for ${symbol}`); continue; }
          buyOutPrev[buyName] = buyOutPrev[buyName]||{}; buyOutPrev[buyName][symbol] = buyOut;

          let buyPrice = TRADE_AMOUNT_USDC / buyOut;
          let sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          let profitPct  = ((profitUSDC / buyPrice) * 100) * (1 - SLIPPAGE_PCT/100);

          console.log(`${symbol} | ${buyName} $${fmt(buyPrice)} → ${sellName} $${fmt(sellPrice)} | Est. Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitUSDC >= MIN_NET_PROFIT_USDC && profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ symbol, buyName, sellName });
            console.log(`🚨 PROFITABLE: executing ${symbol} ${buyName}→${sellName}`);
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (err) {
          console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}: ${err.message}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Opportunities found: ${opportunities.length}`);
  saveCSV();
  return opportunities;
}

// ───────────── MAIN LOOP ─────────────
async function main() {
  console.log("🚀 Live Aave Flash Arbitrage Bot Started");
  while (true) {
    await scan();
    await new Promise(r=>setTimeout(r, 5000)); // continuous loop
  }
}

main().catch(console.error);
