// 🔹 AAVE FLASH ARB BOT — DRY RUN VERSION WITH VAULT DEPOSIT
// Options included: Option 6 (simulation), Option 1 (pre-profit check), Option 5 (ignore no-change trades)

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// 🔹 DRY RUN: set true to simulate only, false to execute live
const DRY_RUN = true;
console.log(`🚀 DRY RUN MODE ENABLED — NO REAL TRADES WILL BE EXECUTED\n`);

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_NET_PROFIT_USDC = 2; // for reference

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

const arbAbi = [
  {
    "inputs": [
      {"internalType": "address","name": "buyRouter","type": "address"},
      {"internalType": "address","name": "sellRouter","type": "address"},
      {"internalType": "address","name": "token","type": "address"},
      {"internalType": "uint256","name": "amountIn","type": "uint256"}
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {"inputs": [],"name": "USDC","outputs": [{"internalType": "address","name": "","type": "address"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "owner","outputs": [{"internalType": "address","name": "","type": "address"}],"stateMutability": "view","type": "function"}
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

(async () => {
  try {
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    const owner = await arbContract.owner();
    console.log("👤 Contract Owner:", owner);
  } catch (err) {
    console.warn("⚠️ Could not fetch contract owner:", err.message);
  }
})();

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

const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 0.5;
const SLIPPAGE_PCT = 0.2;

function fmt(n, dec=4) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), fallback);
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

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

let usdcContract;
(async () => {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, ["function balanceOf(address owner) view returns (uint256)"], provider);
})();

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amount) {
  const timestamp = new Date().toISOString();
  console.log(`💸 Executing trade: ${tokenAddr} Buy:${buyRouter} → Sell:${sellRouter}`);

  try {
    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before Trade: ${before.toFixed(6)} USDC`);

    // Option 6: simulate tx
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(),6)])
      });
    } catch (simErr) {
      console.log("❌ SIMULATION FAILED — Contract would revert:", simErr.message);
      return;
    }

    // Option 1: pre-profit check
    const tokenObj = Object.values(tokens).find(t=>t.address.toLowerCase()===tokenAddr.toLowerCase()) || {address: tokenAddr, decimals:18};
    const buyOut = await getAmountOut(buyRouter, tokenObj, amount);
    const sellOut = await getAmountOut(sellRouter, tokenObj, amount);
    const buyPrice = amount / buyOut;
    const sellPrice = amount / sellOut;
    const expectedProfitUSDC = sellPrice - buyPrice;
    if (expectedProfitUSDC <= 0.000001) {
      console.log(`❌ PREVENTED — Expected profit too small or negative (${expectedProfitUSDC.toFixed(8)} USDC)`);
      return;
    }

    if (!DRY_RUN) {
      const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(),6));
      const receipt = await tx.wait();
      if (!receipt || receipt.status === 0) {
        console.log("❌ Transaction failed — vault unchanged");
        return;
      }
      console.log(`✅ Trade executed: txHash ${receipt.transactionHash}`);
    } else {
      console.log("✅ DRY RUN — Trade simulation passed, no on-chain tx sent");
    }

    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    console.log(`🏦 Vault Balance After Trade: ${after.toFixed(6)} USDC`);

    // Option 5: ignore trades with no vault increase
    if (after <= before) {
      console.log("❌ Trade resulted in no increase — ignored");
      return;
    }

    const netProfit = after - before;
    cumulativeProfit += netProfit;
    console.log(`💰 REAL Net Profit This Trade: ${netProfit.toFixed(6)} USDC`);
    console.log(`💰 Cumulative Profit: ${cumulativeProfit.toFixed(6)} USDC`);

    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase()===tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profit: netProfit });

  } catch(err) {
    console.error(`⚠️ Trade failed: ${err.message}`);
  }
}

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

          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct  = (profitUSDC / buyPrice) * 100;

          profitUSDC *= 1 - SLIPPAGE_PCT/100;
          profitPct  *= 1 - SLIPPAGE_PCT/100;

          console.log(`${symbol} | ${buyName} price: $${fmt(buyPrice)} → ${sellName} price: $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({symbol, buyName, sellName});
            console.log(`🚨 PROFITABLE: ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch(err) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}:`, err.message);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} profitable opportunities.\n`);
  saveCSV();
  return opportunities;
}

async function main() {
  console.log("🚀 Live Aave Flash Arbitrage Bot with Vault Started\n");
  while(true){
    await scan();
    await new Promise(r=>setTimeout(r,5000));
  }
}

main().catch(console.error);
