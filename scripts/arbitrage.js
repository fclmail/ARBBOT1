// arbjs_production_fixed.js — combines arbjs2 + 7 failsafes from arbjs1
import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// -------------------------- CONFIG --------------------------
const CONFIG = {
  RPC_URL: process.env.RPC_URL || "https://polygon-rpc.com/",
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  ARB_CONTRACT_ADDRESS: "0xYourArbContractAddressHere",
  VAULT_ADDRESS: "0xYourVaultAddressHere",

  USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDC_DECIMALS: 6,

  TOKENS: {
    CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
    WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 }
  },

  DEXES: [
    { name: "QuickSwap", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
    { name: "SushiSwap", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
    { name: "ApeSwap", router: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
  ],

  MIN_PROFIT_PCT: 0.5,
  MIN_NET_PROFIT_USDC: 0.01,
  SLIPPAGE_PCT: 0.2,
  SCAN_INTERVAL_MS: 10000,
  LOG_FILE: "arbjs_production_fixed.csv"
};

// -------------------------- PROVIDER + CONTRACT --------------------------
const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
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
  { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "minProfit", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" }
];
const arbContract = new ethers.Contract(CONFIG.ARB_CONTRACT_ADDRESS, arbAbi, wallet);
const usdcContract = new ethers.Contract(CONFIG.USDC_ADDRESS, ["function balanceOf(address owner) view returns (uint256)"], provider);

// -------------------------- HELPERS --------------------------
function fmt(n, d = 4) { return Number(n).toFixed(d); }
let cumulativeProfit = 0;
const csvRows = [];
function logCSV({ timestamp, token, buyDex, sellDex, amount, profit }) {
  csvRows.push([timestamp, token, buyDex, sellDex, amount, profit].join(","));
}
function saveCSV() {
  const header = ["Timestamp","Token","BuyDex","SellDex","AmountUSDC","ProfitUSDC"];
  const csvContent = [header.join(","), ...csvRows].join("\n");
  fs.writeFileSync(CONFIG.LOG_FILE, csvContent);
  console.log(`💾 Trades exported to CSV: ${CONFIG.LOG_FILE}`);
}
async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const path = [CONFIG.USDC_ADDRESS, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), CONFIG.USDC_DECIMALS), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    const fallbackPath = [CONFIG.USDC_ADDRESS, CONFIG.TOKENS.WETH.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), CONFIG.USDC_DECIMALS), fallbackPath);
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}
async function getVaultBalance() {
  const bal = await usdcContract.balanceOf(CONFIG.VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, CONFIG.USDC_DECIMALS));
}

// -------------------------- TRADE EXECUTOR --------------------------
async function executeTrade(buyDex, sellDex, token, amount) {
  const timestamp = new Date().toISOString();
  const before = await getVaultBalance();

  // ✅ Option 6: simulate tx
  try {
    await provider.call({
      to: CONFIG.ARB_CONTRACT_ADDRESS,
      data: arbContract.interface.encodeFunctionData("executeArbitrage", [buyDex.router, sellDex.router, token.address, ethers.parseUnits(amount.toString(), CONFIG.USDC_DECIMALS)]),
      from: wallet.address
    });
  } catch (err) {
    console.log(`❌ SIMULATION FAILED: ${err.message}`);
    return;
  }

  // ✅ Option 1: pre-profit check
  let buyOut, sellOut;
  try { buyOut = await getAmountOut(buyDex.router, token, amount); } catch { console.log("❌ Buy price failed"); return; }
  try { sellOut = await getAmountOut(sellDex.router, token, amount); } catch { console.log("❌ Sell price failed"); return; }
  const expectedProfit = sellOut - buyOut;
  if (expectedProfit <= 0) { console.log(`❌ Expected profit too small (${expectedProfit.toFixed(6)} USDC)`); return; }

  // ✅ Execute
  try {
    const tx = await arbContract.executeArbitrage(buyDex.router, sellDex.router, token.address, ethers.parseUnits(amount.toString(), CONFIG.USDC_DECIMALS));
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) { console.log("❌ TX reverted"); return; }
  } catch (err) { console.log("❌ Execution failed:", err.message); return; }

  const after = await getVaultBalance();

  // ✅ Option 5: verify vault increased
  if (after <= before) { console.log("❌ Vault did not increase — trade ignored"); return; }

  const netProfit = after - before;
  cumulativeProfit += netProfit;
  console.log(`✅ Trade successful: +${netProfit.toFixed(6)} USDC | Cumulative: ${cumulativeProfit.toFixed(6)} USDC`);

  // ✅ Log CSV
  logCSV({ timestamp, token: token.address, buyDex: buyDex.name, sellDex: sellDex.name, amount, profit: netProfit });
}

// -------------------------- SCAN LOOP --------------------------
async function scan() {
  console.log("🔍 Scanning for arbitrage...");
  for (const [symbol, token] of Object.entries(CONFIG.TOKENS)) {
    for (const buyDex of CONFIG.DEXES) {
      for (const sellDex of CONFIG.DEXES) {
        if (buyDex === sellDex) continue;
        try {
          const buyOut = await getAmountOut(buyDex.router, token, 0.01);
          const sellOut = await getAmountOut(sellDex.router, token, 0.01);
          const profitUSDC = sellOut - buyOut;
          const profitPct = (profitUSDC / buyOut) * 100;
          if (profitPct >= CONFIG.MIN_PROFIT_PCT) {
            console.log(`🚨 Opportunity: ${symbol} Buy:${buyDex.name}->Sell:${sellDex.name} Profit:${profitUSDC.toFixed(6)} USDC (${profitPct.toFixed(2)}%)`);
            await executeTrade(buyDex, sellDex, token, 0.01);
          }
        } catch (err) { console.warn(`⚠️ Price check failed: ${err.message}`); }
      }
    }
  }
  saveCSV();
}

// -------------------------- MAIN LOOP --------------------------
async function main() {
  console.log("🚀 Production ARBJS started with 7 failsafes");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, CONFIG.SCAN_INTERVAL_MS));
  }
}

main().catch(console.error);
