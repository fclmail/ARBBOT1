


import dotenv from "dotenv";  
import { ethers } from "ethers";  

dotenv.config();  

/* =========================================================  
   CONFIG  
========================================================= */  

const PRIVATE_KEY =  
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;  

if (!PRIVATE_KEY) {  
  throw new Error("Missing PRIVATE KEY");  
}  

/* =========================================================  
   PROVIDER  
========================================================= */  

const RPC =  
  "https://polygon-bor-rpc.publicnode.com";  

const provider =  
  new ethers.JsonRpcProvider(RPC);  

const wallet =  
  new ethers.Wallet(PRIVATE_KEY, provider);  

/* =========================================================  
   CONTRACT  
========================================================= */  

const CONTRACT_ADDRESS =  
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";  

const arbAbi = [  
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"  
];  

const vault =  
  new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);  

/* =========================================================  
   ROUTER ABI  
========================================================= */  

const routerAbi = [  
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"  
];  

/* =========================================================  
   TOKENS (ONLY FIX: checksum safety added)  
========================================================= */  

const USDC =  
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";  

const WMATIC =  
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";  

const WETH =  
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";  

/* FIXED CHECKSUM LINK */  
const LINK = ethers.getAddress(  
  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"  
);  

const WBTC =  
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";  

const DAI =  
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";  

const CRV =  
  "0x172370d5Cd63279eFa6d502DAB29171933a610AF";  

/* =========================================================  
   ROUTERS  
========================================================= */  

const QUICK =  
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";  

const SUSHI =  
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";  

const quickRouter =  
  new ethers.Contract(QUICK, routerAbi, provider);  

const sushiRouter =  
  new ethers.Contract(SUSHI, routerAbi, provider);  

/* =========================================================  
   SETTINGS  
========================================================= */  

const TRADE_AMOUNT =  
  ethers.parseUnits("50", 6);  

const FLASH_LOAN_FEE_BPS = 9;  

const SLIPPAGE_BPS = 100; // FIXED SAFE SLIPPAGE (1%)  

const GAS_ESTIMATE = 1001244n;  

const LOOP_DELAY = 1000;  

/* =========================================================  
   ROUTES  
========================================================= */  

const ROUTES = [  
  { symbol: "WETH", token: WETH, decimals: 18 },  
  { symbol: "LINK", token: LINK, decimals: 18 },  
  { symbol: "WBTC", token: WBTC, decimals: 8 },  
  { symbol: "DAI", token: DAI, decimals: 18 },  
  { symbol: "CRV", token: CRV, decimals: 18 }  
];  

/* =========================================================  
   HELPERS (NO BREAKING CHANGES)  
========================================================= */  

const fmt = (v, d = 6) =>  
  Number(ethers.formatUnits(v, d)).toFixed(6);  

const sleep = (ms) =>  
  new Promise((r) => setTimeout(r, ms));  

/* =========================================================  
   SLIPPAGE FIX (ONLY ADDITION)  
========================================================= */  

function safeSlippage(rawProfit) {  
  const p = Math.abs(rawProfit) * (SLIPPAGE_BPS / 10000);  

  // HARD CAP (prevents explosion like logs show)  
  return Math.min(Math.max(p, 0.01), 0.05);  
}  

/* =========================================================  
   QUOTES  
========================================================= */  

async function getBuy(token) {  
  const amounts =  
    await quickRouter.getAmountsOut(TRADE_AMOUNT, [  
      USDC,  
      WMATIC,  
      token  
    ]);  

  return amounts[2];  
}  

async function getSell(token, amountIn) {  
  const amounts =  
    await sushiRouter.getAmountsOut(amountIn, [  
      token,  
      WMATIC,  
      USDC  
    ]);  

  return amounts[2];  
}  

/* =========================================================  
   SIMULATION  
========================================================= */  

async function simulate(batch) {  
  try {  
    await vault.executeFlashBatchArbitrage.staticCall(batch);  
    return true;  
  } catch {  
    return false;  
  }  
}  

/* =========================================================  
   EXECUTION  
========================================================= */  

async function execute(batch, sym, profit, start) {  
  console.log("====================================================");  
  console.log("🔥 EXECUTING FLASH BATCH");  
  console.log("====================================================\n");  

  const tx = await vault.executeFlashBatchArbitrage(batch);  

  console.log("🚀 TX HASH:");  
  console.log(tx.hash);  

  console.log("\n⚡ TX STATUS:");  
  console.log("SENT\n");  

  console.log("⏳ WAITING...\n");  

  await tx.wait();  

  const ms = Date.now() - start;  

  console.log("====================================================");  
  console.log("🏁 FINAL RESULTS");  
  console.log("====================================================\n");  

  console.log(`💰 THIS TRADE:\n  ${profit.toFixed(6)} USDC\n`);  
  console.log(`⚡ EXECUTED ROUTE:\n  USDC → WMATIC → ${sym} → USDC\n`);  
  console.log(`⚡ SCAN→EXECUTE:\n  ${ms}ms\n`);  
  console.log("====================================================\n");  
}  

/* =========================================================  
   MAIN LOOP  
========================================================= */  

async function main() {  
  console.log("\n🚀 MICRO→MACRO ARB ENGINE STARTED\n");  

  let totalNetProfit = 0n;  
  let totalTrades = 0;  

  while (true) {  
    console.log("\n🔄 MULTI-ASSET TRIANGULAR SCAN");  
    console.log("====================================================\n");  

    for (const r of ROUTES) {  
      const start = Date.now();  

      try {  
        const buy = await getBuy(r.token);  
        const sell = await getSell(r.token, buy);  

        const raw = Number(fmt(sell - TRADE_AMOUNT));  

        const gas = Number(  
          ethers.formatEther(GAS_ESTIMATE)  
        ) * 0.9;  

        const fee = Number(  
          fmt((TRADE_AMOUNT * BigInt(FLASH_LOAN_FEE_BPS)) / 10000n)  
        );  

        const slip = safeSlippage(raw);  

        const net = raw - gas - fee - slip;  

        // User-friendly USDC values  
        const buyUSDC = Number(fmt(TRADE_AMOUNT));  
        const sellUSDC = Number(fmt(sell));  

        console.log(`📡 SCANNING:\n${r.symbol}`);  
        console.log(`USDC → WMATIC → ${r.symbol} → USDC\n`);  

        console.log(`💰 BUY:\n  ${buyUSDC.toFixed(2)} USDC → ${fmt(buy, r.decimals)} ${r.symbol}`);  
        console.log(`💰 SELL:\n  ${fmt(buy, r.decimals)} ${r.symbol} → ${sellUSDC.toFixed(2)} USDC\n`);  

        console.log(`📊 RAW PROFIT:\n  ${raw.toFixed(6)} USDC\n`);  
        console.log(`⚡ EST GAS COST:\n  ${gas.toFixed(6)} USDC\n`);  
        console.log(`⚡ FLASH LOAN FEE:\n  ${fee.toFixed(6)} USDC\n`);  
        console.log(`⚡ SLIPPAGE BUFFER:\n  ${slip.toFixed(6)} USDC\n`);  
        console.log(`⚡ NET PROFIT:\n  ${net.toFixed(6)} USDC\n`);

        if (net <= 0) {
          console.log(`⚡ RESULT:\nSKIPPED`);
          console.log("====================================================\n");
          continue;
        }

        console.log(`⚡ RESULT:\nPROFITABLE`);
        console.log("====================================================\n");

        // Build batch
        const batch = {
          buyRouters: [QUICK],
          sellRouters: [SUSHI],
          amountsInUSDC: [TRADE_AMOUNT],
          pathsToToken: [[USDC, WMATIC, r.token]],
          pathsToUSDC: [[r.token, WMATIC, USDC]],
          deadline: Math.floor(Date.now() / 1000) + 120
        };

        // Simulate
        const ok = await simulate(batch);
        if (!ok) continue;

        // Execute
        await execute(batch, r.symbol, net, start);

        // Accumulate
        const profitScaled = ethers.parseUnits(net.toFixed(6), 6);
        totalNetProfit += profitScaled;
        totalTrades++;

        console.log(`📊 ACCUMULATED PROFIT:\n  ${fmt(totalNetProfit)} USDC\n`);
        console.log(`📊 TOTAL TRADES:\n  ${totalTrades}\n`);

      } catch (err) {
        console.log(`❌ ERROR:\n${r.symbol} → ${err.message}\n`);
      }
    }

    console.log("⏳ LOOPING...\n");
    await sleep(LOOP_DELAY);
  }
}

/* =========================================================
   START
========================================================= */

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
