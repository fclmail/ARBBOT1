// improved-arbitrage.js
// EXACT SAME CODE — ONLY LIVE EXECUTION FIXES APPLIED

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const CLI_ARGS = process.argv.slice(2);
const CLI_LIVE = CLI_ARGS.includes("--live") || CLI_ARGS.includes("-l");

// DRY_RUN logic
const ENV_DRY = process.env.DRY_RUN;
const DRY_RUN = CLI_LIVE ? false : (typeof ENV_DRY === "string" ? (ENV_DRY === "true") : true);

console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trading config
const MIN_PROFIT_PCT      = Number(process.env.MIN_PROFIT_PCT || 20);
const MIN_TRADE_USDC      = Number(process.env.MIN_TRADE_USDC || 0.5);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.001);
const SLIPPAGE_PCT        = Number(process.env.SLIPPAGE_PCT || 0.0);
const MAX_PROFIT_PCT      = Number(process.env.MAX_PROFIT_PCT || 40);

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

const WMATIC = { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 };

// CSV logging
const csvRows = [];
function logTradeCSV(r) {
  csvRows.push([
    r.timestamp, r.symbol, r.buyRouter, r.sellRouter, r.amount, 
    r.profitUSDC, r.cumulative, r.note
  ].join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","CumulativeProfitUSDC","Note"];
  const fn = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(fn, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${fn}`);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ABI
const arbAbi = [
  {
    "inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],
    "name":"executeArbitrage",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  { "inputs":[], "name":"USDC","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function" },
  { "inputs":[], "name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function" }
];

const arbContract = DRY_RUN
  ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
  : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

let usdcContract;
const erc20Abi = ["function balanceOf(address) view returns (uint256)","function decimals() view returns (uint8)"];

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    console.log("🏛 Contract:", CONTRACT_ADDRESS);
    console.log("💱 USDC:", usdcAddr);
  } catch (e) {}
}

function toDecimalString(value, decimals = 18) {
  const num = typeof value === "number" ? value : Number(value);
  const s = num.toFixed(decimals);
  return s.indexOf('.') === -1 ? s : s.replace(/\.?0+$/, '');
}

// Helpers
async function routerGetAmountsOut(routerAddr, amountInWei, path) {
  const r = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  return r.getAmountsOut(amountInWei, path);
}

async function getTokenAmountFromUSDC(routerAddr, token, amountUSDC, usdcAddr) {
  const amt = ethers.parseUnits(toDecimalString(amountUSDC,6), 6);
  try {
    const a = await routerGetAmountsOut(routerAddr, amt, [usdcAddr, token.address]);
    return Number(ethers.formatUnits(a[a.length - 1], token.decimals));
  } catch {
    const a = await routerGetAmountsOut(routerAddr, amt, [usdcAddr, WMATIC.address, token.address]);
    return Number(ethers.formatUnits(a[a.length - 1], token.decimals));
  }
}

async function getUSDCFromToken(routerAddr, token, tokenAmount, usdcAddr) {
  const amt = ethers.parseUnits(toDecimalString(tokenAmount, token.decimals), token.decimals);
  try {
    const a = await routerGetAmountsOut(routerAddr, amt, [token.address, usdcAddr]);
    return Number(ethers.formatUnits(a[a.length - 1], 6));
  } catch {
    const a = await routerGetAmountsOut(routerAddr, amt, [token.address, WMATIC.address, usdcAddr]);
    return Number(ethers.formatUnits(a[a.length - 1], 6));
  }
}

// *** FIXED gas-cost BigInt math ***
async function estimateGasCostInUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  try {
    const amountWei = ethers.parseUnits(toDecimalString(amountUSDC,6), 6);

    const gasEstimate = await arbContract.estimateGas.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, amountWei
    );

    const fee = await provider.getFeeData();
    const gp = fee.maxFeePerGas || fee.gasPrice;

    const gasCostWei = gasEstimate * gp;     // both are BigInt
    const gasCostNative = Number(ethers.formatUnits(gasCostWei, 18));

    const usdcAddr = await arbContract.USDC();
    const amounts = await routerGetAmountsOut(
      routers.QuickSwap,
      ethers.parseUnits(gasCostNative.toString(),18),
      [WMATIC.address, usdcAddr]
    );
    return { gasEstimate, gasCostNative, gasCostUSDC:Number(ethers.formatUnits(amounts[1],6)) };
  } catch {
    return { gasEstimate:null, gasCostNative:null, gasCostUSDC:Infinity };
  }
}

// EXECUTION
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();

  const usdcAddr = await arbContract.USDC();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase()===tokenAddr.toLowerCase()) || { address:tokenAddr, decimals:18 };

  let beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const before = Number(ethers.formatUnits(beforeBal,6));

  const tokenOut = await getTokenAmountFromUSDC(buyRouter, tokenObj, amountUSDC, usdcAddr);
  const usdcReturned = await getUSDCFromToken(sellRouter, tokenObj, tokenOut, usdcAddr);

  const expectedProfitUSDC = (usdcReturned - amountUSDC) * (1 - SLIPPAGE_PCT/100);
  const pct = (expectedProfitUSDC / amountUSDC) * 100;

  if (pct < MIN_PROFIT_PCT) return;

  // Gas
  const { gasEstimate, gasCostUSDC } = await estimateGasCostInUSDC(
    buyRouter, sellRouter, tokenAddr, amountUSDC
  );

  const profitAfterGas = expectedProfitUSDC - gasCostUSDC;
  if (profitAfterGas <= 0) return;

  // *** FIXED SIMULATION — use wallet or null, NOT contract address ***
  try {
    await provider.call({
      to: CONTRACT_ADDRESS,
      data: arbContract.interface.encodeFunctionData("executeArbitrage", [
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(toDecimalString(amountUSDC,6),6)
      ]),
      from: wallet ? wallet.address : undefined
    });
  } catch {
    console.log("SIM FAILED — skipping");
    return;
  }

  // *** LIVE TX ***
  if (!DRY_RUN) {
    const amountWei = ethers.parseUnits(toDecimalString(amountUSDC,6),6);

    // FIXED: replace .mul() with native BigInt
    const gasLimit = gasEstimate ? BigInt(gasEstimate) * 120n / 100n : undefined;

    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, amountWei,
      { gasLimit }
    );

    console.log("TX SENT:", tx.hash);
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      console.log("TX FAILED");
      return;
    }

    console.log("TX SUCCESS:", receipt.transactionHash);
  }

  // After balance
  let afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const after = Number(ethers.formatUnits(afterBal,6));

  const realProfit = after - before;
  console.log("REAL PROFIT:", realProfit, "USDC");

  cumulativeProfit += realProfit;

  logTradeCSV({
    timestamp, symbol:getSymbol(tokenAddr),
    buyRouter, sellRouter,
    amount:amountUSDC,
    profitUSDC:realProfit,
    cumulative:cumulativeProfit
  });
}

function getSymbol(addr){
  const e = Object.entries(tokens).find(([k,v]) => v.address.toLowerCase()===addr.toLowerCase());
  return e ? e[0] : addr;
}

async function scanAllPairs(){
  const usdc = await arbContract.USDC();

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [bn,buy] of Object.entries(routers)) {
      for (const [sn,sell] of Object.entries(routers)) {
        if (bn===sn) continue;

        try {
          const tokenOut = await getTokenAmountFromUSDC(buy, token, TRADE_AMOUNT_USDC, usdc);
          const usdcReturned = await getUSDCFromToken(sell, token, tokenOut, usdc);
          const profit = (usdcReturned - TRADE_AMOUNT_USDC) * (1 - SLIPPAGE_PCT/100);
          const pct = (profit / TRADE_AMOUNT_USDC) * 100;

          if (pct >= MIN_PROFIT_PCT) {
            await executeTradeLive(buy, sell, token.address, TRADE_AMOUNT_USDC);
          }
        } catch {}
      }
    }
  }
}

const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || MIN_TRADE_USDC);

// MAIN
(async()=>{
  await init();
  console.log("RUNNER STARTED");

  setInterval(async()=>{
    await scanAllPairs();
    saveCSV();
  }, 10000);
})();
