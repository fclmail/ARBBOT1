// FULL UPDATED ARBJS (PASTABLE)
// (Same content as canvas, cleaned and ready to paste)

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const DRY_RUN = false;
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_NET_PROFIT_USDC = Number(process.env.MIN_NET_PROFIT_USDC || "2");
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || "0.5");
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || "0.2");
const MAX_PRICE_DEVIATION_PCT = Number(process.env.MAX_PRICE_DEVIATION_PCT || "10");
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || "0.001");

const NATIVE_USD_PRICE = process.env.NATIVE_USD_PRICE ? Number(process.env.NATIVE_USD_PRICE) : null;
if (!NATIVE_USD_PRICE) console.warn("⚠️ NATIVE_USD_PRICE not set — gas checks disabled");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

const arbAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { inputs: [], name: "USDC", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" }
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint amount) returns (bool)"
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

let cumulativeProfit = 0;
const csvRows = [];
function logTradeCSV(r) { csvRows.push([r.timestamp,r.symbol,r.buyRouter,r.sellRouter,r.amount,r.profit].join(",")); }
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const csv = [header.join(","), ...csvRows].join("
");
  const f = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(f, csv);
  console.log("💾 Saved CSV:", f);
}

function fmt(n, d=6) { return Number(n).toFixed(d); }

async function getUSDC() { return new ethers.Contract(await arbContract.USDC(), erc20Abi, provider); }
async function getVaultBalanceUSDC() {
  const usdc = await getUSDC();
  return Number(ethers.formatUnits(await usdc.balanceOf(CONTRACT_ADDRESS), 6));
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(routerAddr,["function getAmountsOut(uint, address[]) view returns (uint[])",],provider);
  const usdc = await arbContract.USDC();
  const path = [usdc, token.address];
  try {
    const a = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(),6), path);
    return Number(ethers.formatUnits(a[1],token.decimals));
  } catch {
    const fp = [usdc, tokens.WBTC.address, token.address];
    const a = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(),6), fp);
    return Number(ethers.formatUnits(a[2],token.decimals));
  }
}

function percent(a,b){ return Math.abs((a-b)/((a+b)/2))*100; }

async function estimateGasCostUSDC(buyRouter,sellRouter,tokenAddr,amount){
  if(!NATIVE_USD_PRICE) throw new Error("Missing NATIVE_USD_PRICE");
  const amt = ethers.parseUnits(amount.toString(),6);
  const gasEst = await arbContract.estimateGas.executeArbitrage(buyRouter,sellRouter,tokenAddr,amt);
  const fee = await provider.getFeeData();
  const gp = fee.maxFeePerGas || fee.gasPrice;
  const gasCostNative = Number(ethers.formatUnits(gasEst*gp,18));
  return { gasCostUSD: gasCostNative*NATIVE_USD_PRICE, gasEstimate: gasEst.toString() };
}

async function executeTradeLive(buyRouter,sellRouter,tokenAddr,amount){
  const timestamp=new Date().toISOString();
  console.log("💸 Executing with failsafes...");

  const vb=await getVaultBalanceUSDC();
  console.log("Vault Before:",fmt(vb));

  let gas={gasCostUSD:0};
  try{ gas=await estimateGasCostUSDC(buyRouter,sellRouter,tokenAddr,amount);}catch(e){
    console.warn("Gas estimate fail",e.message);
    if(!DRY_RUN) return;
  }
  console.log("Gas estimate:",fmt(gas.gasCostUSD));

  try{
    await arbContract.callStatic.executeArbitrage(buyRouter,sellRouter,tokenAddr,ethers.parseUnits(amount.toString(),6));
  }catch(e){
    console.log("❌ callStatic failed → block");
    return;
  }

  if(DRY_RUN){ console.log("DRY RUN mode"); return; }

  let tx;
  try{
    tx=await arbContract.executeArbitrage(buyRouter,sellRouter,tokenAddr,ethers.parseUnits(amount.toString(),6),{gasLimit:900000});
  }catch(e){ console.log("Send fail",e.message); return; }

  if(!tx.hash){ console.log("❌ No txHash — abort"); return; }
  console.log("txHash:",tx.hash);

  let rc;
  try{ rc=await tx.wait(); }catch{ console.log("❌ revert"); return; }
  if(!rc || rc.status!==1){ console.log("❌ status!=1"); return; }

  const va=await getVaultBalanceUSDC();
  console.log("Vault After:",fmt(va));
  if(va<=vb){ console.log("❌ Vault decreased — block"); return; }

  const profit=va-vb;
  cumulativeProfit+=profit;
  console.log("Profit:",fmt(profit));

  logTradeCSV({timestamp,symbol:tokenAddr,buyRouter,sellRouter,amount,profit});
}

async function scan(){
  console.log("Scanning...");
  const ops=[];

  for(const[sym,token] of Object.entries(tokens)){
    for(const[bn,br] of Object.entries(routers)){
      for(const[sn,sr] of Object.entries(routers)){
        if(bn===sn) continue;
        try{
          const bo=await getAmountOut(br,token,TRADE_AMOUNT_USDC);
          const so=await getAmountOut(sr,token,TRADE_AMOUNT_USDC);

          const bp=TRADE_AMOUNT_USDC/bo;
          const sp=TRADE_AMOUNT_USDC/so;

          let p=sp-bp;
          p*=1-SLIPPAGE_PCT/100;
          const pct=(p/bp)*100;

          const dev=percent(bp,sp);
          if(dev>MAX_PRICE_DEVIATION_PCT) continue;
          if(pct<MIN_PROFIT_PCT) continue;

          let gas=0;
          try{ gas=(await estimateGasCostUSDC(br,sr,token.address,TRADE_AMOUNT_USDC)).gasCostUSD; }catch{}
          const net=p-gas;
          if(net<MIN_NET_PROFIT_USDC) continue;

          ops.push({sym,bn,sn});
          await executeTradeLive(br,sr,token.address,TRADE_AMOUNT_USDC);
        }catch{}
      }
    }
  }

  saveCSV();
  return ops;
}

(async()=>{
  console.log("ARBJS Ready");
  try{ console.log("Owner:",await arbContract.owner()); }catch{}
  while(true){ await scan(); await new Promise(r=>setTimeout(r,5000)); }
})();
