// improved-arb-loop-dry.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = true; // FORCED TO TRUE
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // not used in dry run
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TRADE_INTERVAL_MS = 30000; // 30 seconds

// Trading defaults
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.5);
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.05);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.3);

// ---------- Routers & tokens ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 }
};

// ---------- CSV Logging ----------
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = null; // DRY_RUN

// ---------- VAULT CONTRACT ----------
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address","name": "buyRouter","type": "address" },
      { "internalType": "address","name": "sellRouter","type": "address" },
      { "internalType": "address","name": "token","type": "address" },
      { "internalType": "uint256","name": "amountIn","type": "uint256" },
      { "internalType": "uint256","name": "minReturnUSDC","type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [], "stateMutability": "nonpayable","type":"function"
  },
  { "inputs": [], "name": "USDC", "outputs":[{"internalType":"address","name":"","type":"address"}], "stateMutability":"view","type":"function" },
  { "inputs": [], "name": "owner", "outputs":[{"internalType":"address","name":"","type":"address"}], "stateMutability":"view","type":"function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
let usdcContract;

// ---------- INIT ----------
async function init() {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
  const owner = await arbContract.owner();
  console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
  console.log("👤 Contract Owner:", owner);
  console.log("💱 USDC token address:", usdcAddr);
}

// ---------- HELPERS ----------
function fmt(n, dec=6){ return Number(n).toFixed(dec); }
async function getAmountsOutRaw(routerAddr, path, amountInUnits){
  const router = new ethers.Contract(routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  return await router.getAmountsOut(amountInUnits, path);
}
async function getAmountOut(routerAddr, token, amountUSDC){
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  const amounts = await getAmountsOutRaw(routerAddr, path, ethers.parseUnits(amountUSDC.toString(), 6));
  return Number(ethers.formatUnits(amounts[amounts.length-1], token.decimals));
}
async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC){
  const usdcAddr = await arbContract.USDC();
  const amountInUnits = ethers.parseUnits(amountUSDC.toString(), 6);
  const buyAmounts = await getAmountsOutRaw(buyRouter, [usdcAddr, tokenObj.address], amountInUnits);
  const tokenAmount = buyAmounts[buyAmounts.length-1];
  const sellAmounts = await getAmountsOutRaw(sellRouter, [tokenObj.address, usdcAddr], tokenAmount);
  const expectedUSDCAfter = Number(ethers.formatUnits(sellAmounts[sellAmounts.length-1], 6));
  const safetyMultiplier = 1 - (SLIPPAGE_PCT/100) - 0.0025;
  return ethers.parseUnits((expectedUSDCAfter * safetyMultiplier).toFixed(6),6);
}

// ---------- EXECUTE TRADE ----------
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountUSDC){
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase());
  if(!tokenObj){ console.log("⛔ Token not whitelisted"); return; }
  if(buyRouter.toLowerCase() === sellRouter.toLowerCase()) return;

  const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const before = Number(ethers.formatUnits(beforeBal,6));
  if(amountUSDC > before) {
    console.log(`⚠️ Skipping trade — vault has insufficient USDC (${fmt(before)} < ${amountUSDC})`);
    return;
  }

  const minReturnBN = await computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC);
  console.log(`🧪 DRY_RUN: would trade ${amountUSDC} USDC on ${tokenAddr} | minReturn ${ethers.formatUnits(minReturnBN,6)}`);
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = MIN_TRADE_USDC;
async function scanOnce(){
  for(const [symbol, token] of Object.entries(tokens)){
    for(const [buyName, buyRouter] of Object.entries(routers)){
      for(const [sellName, sellRouter] of Object.entries(routers)){
        if(buyRouter === sellRouter) continue;
        try{
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          const expectedProfit = (sellPrice - buyPrice)*(1 - SLIPPAGE_PCT/100);
          const profitPct = (expectedProfit/buyPrice)*100;
          if(profitPct >= MIN_PROFIT_PCT){
            console.log(`🚨 Arbitrage detected: ${symbol} ${buyName}->${sellName} estProfit ${fmt(expectedProfit)} USDC`);
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch(e){ console.warn("⚠️ Scan error:", e.reason || e.message); }
      }
    }
  }
  saveCSV();
}

// ---------- MAIN LOOP ----------
(async function main(){
  await init();
  console.log(`🚀 Arbitrage bot started (DRY_RUN=${DRY_RUN})`);
  setInterval(async ()=>{
    console.log("\n🔍 Scanning for arbitrage opportunities...");
    await scanOnce();
  }, TRADE_INTERVAL_MS);
})();
