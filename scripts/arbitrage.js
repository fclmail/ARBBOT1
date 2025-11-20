import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARB_CONTRACT_ADDRESS = process.env.ARB_CONTRACT_ADDRESS;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const DRY_RUN = process.env.DRY_RUN === "true" || false;

if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

// ---------------- HELPERS ----------------
function validateAddress(addr, name) {
  if (!addr || !ethers.isAddress(addr)) {
    console.warn(`⚠️ ${name} is missing or invalid, DRY_RUN mode will be used`);
    return null;
  }
  return addr;
}

const arbAddress = validateAddress(ARB_CONTRACT_ADDRESS, "ARB_CONTRACT_ADDRESS");
const vaultAddress = validateAddress(VAULT_ADDRESS, "VAULT_ADDRESS");

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ---------------- CONTRACT ----------------
const ARB_ABI = [
  { "inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],"name":"executeArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function"},
  { "inputs":[],"name":"USDC","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function" }
];

const arbContract = arbAddress ? new ethers.Contract(arbAddress, ARB_ABI, wallet) : null;

// ---------------- ROUTERS & TOKENS ----------------
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

// ---------------- SETTINGS ----------------
const TRADE_AMOUNT_USDC = 0.001;
const MIN_PROFIT_USDC = 0.0001;

// ---------------- CSV LOGGING ----------------
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit, profitPct }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profit, profitPct].join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","ProfitPct"];
  const csvContent = [header.join(","), ...csvRows].join("\n");
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, csvContent);
  console.log(`💾 Trades exported to CSV: ${filename}`);
}

// ---------------- ERC20 + USDC ----------------
let usdcContract = null;
(async () => {
  if (!arbContract) return;
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, ["function balanceOf(address owner) view returns (uint256)","function decimals() view returns (uint8)"], provider);
})();

// ---------------- GET AMOUNT OUT ----------------
async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  if (!arbContract) return 0;
  const usdcAddr = await arbContract.USDC();
  const paths = [
    [usdcAddr, token.address],
    [usdcAddr, tokens.WBTC.address, token.address]
  ];

  for (const path of paths) {
    try {
      const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
      const outAmount = Number(ethers.formatUnits(amounts[amounts.length-1], token.decimals));
      if (outAmount > 0) return outAmount;
    } catch {}
  }
  return 0;
}

// ---------------- EXECUTE TRADE ----------------
async function executeTrade(buyRouter, sellRouter, token, amountUSDC, buyAmount, sellAmount) {
  if (!arbContract) { console.log("⚠️ DRY_RUN: skipping execution"); return; }

  const timestamp = new Date().toISOString();
  const profit = sellAmount - buyAmount;
  const profitPct = (profit / buyAmount) * 100;

  if (profit <= 0 || profit < MIN_PROFIT_USDC) return;

  console.log(`💰 EXECUTING: ${token} | ${buyRouter} → ${sellRouter} | Profit: ${profit.toFixed(6)} USDC (${profitPct.toFixed(2)}%)`);
  logTradeCSV({ timestamp, symbol: token, buyRouter, sellRouter, amount: amountUSDC, profit, profitPct });

  try {
    // Vault balance before
    const before = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));

    // Execute arbitrage
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokens[token].address, ethers.parseUnits(amountUSDC.toString(), 6));
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) { console.log("❌ TX failed"); return; }

    // Vault balance after
    const after = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
    const netProfit = after - before;
    console.log(`✅ Trade complete | Net Profit USDC: ${netProfit.toFixed(6)}`);
  } catch (err) { console.error("⚠️ Trade execution failed:", err.message); }
}

// ---------------- SCAN LOOP ----------------
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          const profit = sellOut - buyOut;
          const profitPct = buyOut > 0 ? (profit / buyOut) * 100 : 0;
          console.log(`${symbol} | ${buyName} → ${sellName} | Buy: ${buyOut.toFixed(6)} | Sell: ${sellOut.toFixed(6)} | Profit: ${profit.toFixed(6)} USDC (${profitPct.toFixed(2)}%)`);
          if (profit > MIN_PROFIT_USDC) await executeTrade(buyName, sellName, symbol, TRADE_AMOUNT_USDC, buyOut, sellOut);
        } catch (err) {
          console.warn(`⚠️ ${symbol} ${buyName}→${sellName} failed: ${err.message}`);
        }
      }
    }
  }
  saveCSV();
}

// ---------------- MAIN LOOP ----------------
async function main() {
  console.log("🚀 Starting Arb Bot...");
  while (true) {
    try { await scan(); }
    catch (err) { console.error("⚠️ Scan error:", err.message); }
    await new Promise(r => setTimeout(r, 5000));
  }
}

main();
