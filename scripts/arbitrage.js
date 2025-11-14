// scripts/arbitrage.js
// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (callStatic + gas + net profit + logs)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const SCAN_INTERVAL_MS = 40_000; // 40s
const TRADE_AMOUNT_USDC = 0.01; // default trade amount
const MIN_PROFIT_PCT = 3;       // minimum profit %
const MIN_NET_PROFIT_USDC = 1;  // minimum net profit

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ABI ───────────────
const arbAbi = [
  {"inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],"name":"executeArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"asset","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"address","name":"","type":"address"},{"internalType":"bytes","name":"params","type":"bytes"}],"name":"executeOperation","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"_minProfit","type":"uint256"}],"name":"setMinProfit","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"token","type":"address"}],"name":"withdrawProfit","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"AAVE_POOL","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"minProfit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"USDC","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── Routers ───────────────
const routerAddressesRaw = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};
const routers = {};
for (const [k,v] of Object.entries(routerAddressesRaw)){
  try { routers[k] = ethers.getAddress(v); } catch(e){ console.warn(`Skipping invalid router ${k}`);}
}

// ─────────────── Tokens ───────────────
const tokens = {
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// WMATIC for gas → USDC
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const QUICKSWAP_ROUTER = routers.QuickSwap || null;

// ─────────────── Helpers ───────────────
function fmt(n, dec=6){ return Number(n).toFixed(dec); }

async function getUSDCAddress(){ return await arbContract.USDC(); }

async function getAmountOut(routerAddr, token, amountHumanUSDC){
  const usdcAddr = await getUSDCAddress();
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn,address[] memory path) view returns (uint[] memory)"], provider);
  const amountIn = ethers.parseUnits(amountHumanUSDC.toString(),6);
  const path = [usdcAddr, token.address];
  try {
    const amounts = await router.getAmountsOut(amountIn,path);
    return Number(ethers.formatUnits(amounts[amounts.length-1], token.decimals));
  } catch(_){
    const path2 = [usdcAddr, WMATIC, token.address];
    const amounts = await router.getAmountsOut(amountIn,path2);
    return Number(ethers.formatUnits(amounts[amounts.length-1], token.decimals));
  }
}

async function getContractUSDCBalance(){ 
  const usdcAddr = await getUSDCAddress();
  const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = await usdc.balanceOf(CONTRACT_ADDRESS);
  return Number(ethers.formatUnits(bal,6));
}

async function estimateGas(populatedTx){
  const gasEstimate = await wallet.estimateGas(populatedTx);
  const gasPrice = await provider.getGasPrice();
  const gasCostMatic = Number(ethers.formatUnits(gasEstimate * gasPrice,18));
  return { gasEstimate, gasPrice, gasCostMatic };
}

async function convertMaticToUSDC(maticAmount){
  if(!QUICKSWAP_ROUTER) return null;
  try {
    const router = new ethers.Contract(QUICKSWAP_ROUTER, ["function getAmountsOut(uint,address[] memory) view returns(uint[])"], provider);
    const usdcAddr = await getUSDCAddress();
    const amountIn = ethers.parseUnits(maticAmount.toString(),18);
    const amounts = await router.getAmountsOut(amountIn,[WMATIC, usdcAddr]);
    return Number(ethers.formatUnits(amounts[amounts.length-1],6));
  } catch { return null; }
}

async function executeTrade(buyRouter, sellRouter, tokenAddr, amountHumanUSDC){
  const amountUnits = ethers.parseUnits(amountHumanUSDC.toString(),6);
  const populated = await arbContract.populateTransaction.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountUnits);
  try { await arbContract.callStatic.executeArbitrage(buyRouter,sellRouter,tokenAddr,amountUnits); } 
  catch(err){ return { executed:false, reason:err.reason||err.message||err }; }
  const { gasEstimate, gasPrice, gasCostMatic } = await estimateGas(populated);
  const gasCostUSDCapprox = await convertMaticToUSDC(gasCostMatic);
  return { executed:true, populated, gasEstimate, gasPrice, gasCostMatic, gasCostUSDCapprox };
}

async function sendTradeTx(populatedTx){
  const gasLimit = (await wallet.estimateGas(populatedTx))*2n;
  const tx = await wallet.sendTransaction({ to: CONTRACT_ADDRESS, data: populatedTx.data, gasLimit });
  const receipt = await tx.wait();
  return receipt;
}

// ─────────────── Scan loop ───────────────
async function scanOnce(tradeAmountHuman = TRADE_AMOUNT_USDC){
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];
  for(const [sym,token] of Object.entries(tokens)){
    for(const [buyName,buyRouter] of Object.entries(routers)){
      for(const [sellName,sellRouter] of Object.entries(routers)){
        if(buyName===sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter,token,tradeAmountHuman);
          const sellOut = await getAmountOut(sellRouter,token,tradeAmountHuman);
          if(!buyOut||!sellOut) continue;
          const buyPrice = tradeAmountHuman/buyOut;
          const sellPrice = tradeAmountHuman/sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = profitUSDC/buyPrice*100;
          if(profitPct<MIN_PROFIT_PCT || profitUSDC<=0) continue;

          console.log(`\n🚨 ${sym} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Gross: ${fmt(profitUSDC,6)} USDC`);

          const sim = await executeTrade(buyRouter,sellRouter,token.address,tradeAmountHuman);
          if(!sim.executed){ console.warn(`⚠️ Skipping trade: ${sim.reason}`); continue; }

          let netProfit = profitUSDC;
          if(sim.gasCostUSDCapprox) netProfit -= sim.gasCostUSDCapprox;

          if(netProfit<MIN_NET_PROFIT_USDC){ console.log(`⚠️ Net profit ${fmt(netProfit)} < MIN_NET_PROFIT_USDC`); continue; }

          const contractBefore = await getContractUSDCBalance();
          const receipt = await sendTradeTx(sim.populated);
          const contractAfter = await getContractUSDCBalance();
          console.log(`✅ Tx mined: ${receipt.transactionHash} | Net USDC change: ${fmt(contractAfter-contractBefore)} USDC`);

          opportunities.push({ token:sym, buyName, sellName, grossProfit:profitUSDC, netProfit });
        } catch(e){ console.warn(`⚠️ Error scanning ${sym} ${buyName}->${sellName}: ${e.message||e}`); }
      }
    }
  }
  console.log(`🔍 Scan pass finished. Found ${opportunities.length} opportunities.`);
  return opportunities;
}

// ─────────────── Main Loop ───────────────
async function main(){
  console.log("🚀 Aave Flash Arbitrage Bot running...");
  if(typeof arbContract.executeArbitrage!=="function"){ console.error("❌ executeArbitrage missing"); return; }
  while(true){ try{ await scanOnce(TRADE_AMOUNT_USDC); } catch(err){ console.error("⚠️ Scan error:",err); } await new Promise(r=>setTimeout(r,SCAN_INTERVAL_MS)); }
}

main().catch(err=>console.error("Fatal error:",err));
