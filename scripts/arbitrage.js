// live-arb.js
import { ethers, Wallet, Interface } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false; // LIVE mode
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// Deployed contract
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trading defaults
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.005); // % profit over buy
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.05); // low trade amount
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.005);    // gas conservative estimate
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001); // very low
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.3);     // slippage allowance %
const STABILITY_SAMPLES = Number(process.env.STABILITY_SAMPLES || 3);
const STABILITY_DELAY_MS = Number(process.env.STABILITY_DELAY_MS || 150);

// ---------- Routers & tokens ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
    CRV:{address:"0x172370d5cd63279efa6d502dab29171933a610af",decimals:18},
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 }
};

// CSV Logging
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
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ABIs ----------
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
      { "internalType": "uint256", "name": "minReturnUSDC", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = DRY_RUN
  ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
  : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// USDC ERC20 helper
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];
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

// ---------- MIN RETURN COMPUTE ----------
async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC){
  const usdcAddr = await arbContract.USDC();
  const amountInUnits = ethers.parseUnits(amountUSDC.toString(), 6);
  let buyAmounts = await getAmountsOutRaw(buyRouter, [usdcAddr, tokenObj.address], amountInUnits);
  const tokenAmount = buyAmounts[buyAmounts.length-1];
  let sellAmounts = await getAmountsOutRaw(sellRouter, [tokenObj.address, usdcAddr], tokenAmount);
  const expectedUSDCAfter = Number(ethers.formatUnits(sellAmounts[sellAmounts.length-1], 6));
  const safetyMultiplier = 1 - (SLIPPAGE_PCT/100) - 0.0025;
  return ethers.parseUnits((expectedUSDCAfter * safetyMultiplier).toFixed(6),6);
}

// ---------- EXECUTE ARBITRAGE ----------
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountUSDC){
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase());
  if(!tokenObj){ console.log("⛔ Token not whitelisted"); return; }
  const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const before = Number(ethers.formatUnits(beforeBal, 6));
  const minReturnBN = await computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC);

  if(DRY_RUN){
    console.log(`🧪 DRY_RUN: would trade ${amountUSDC} USDC on ${tokenAddr} | minReturn ${ethers.formatUnits(minReturnBN,6)}`);
    return;
  }

  const tx = await arbContract.executeArbitrage(
    buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6), minReturnBN
  );
  console.log(`🚀 Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  if(receipt.status === 1){
    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    console.log(`✅ Trade success. Profit: ${fmt(after-before)} USDC`);
    csvRows.push([new Date().toISOString(), tokenAddr, buyRouter, sellRouter, amountUSDC, fmt(after-before)].join(","));
  } else {
    console.log("❌ Trade failed or reverted");
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = 0.05; // small trade for vault 0.07
async function scanOnce(){
  for(const [symbol, token] of Object.entries(tokens)){
    for(const [buyName, buyRouter] of Object.entries(routers)){
      for(const [sellName, sellRouter] of Object.entries(routers)){
        if(buyRouter===sellRouter) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          const expectedProfit = (sellPrice - buyPrice)*(1 - SLIPPAGE_PCT/100);
          const profitPct = (expectedProfit/buyPrice)*100;
          if(expectedProfit >= MIN_EXPECTED_PROFIT && profitPct >= MIN_PROFIT_PCT){
            console.log(`🚨 Arbitrage detected: ${symbol} ${buyName}->${sellName} estProfit ${fmt(expectedProfit)} USDC`);
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          } else {
            console.log(`💹 ${symbol} ${buyName}->${sellName} estProfit ${fmt(expectedProfit)} USDC | skipped`);
          }
        } catch(e){ console.warn("⚠️ Scan error:", e.message); }
      }
    }
  }
  saveCSV();
}

// ---------- MAIN LOOP ----------
(async()=>{
  await init();
  console.log("🚀 Arbitrage bot started (LIVE)");
  setInterval(async ()=>{
    console.log("🔍 Scanning for arbitrage opportunities...");
    await scanOnce();
  }, 30*1000); // 30s interval
})();
