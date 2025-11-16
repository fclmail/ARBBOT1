import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // deployed contract
const MIN_PROFIT_PCT = 3; // min % profit
const TRADE_AMOUNT_USDC = 1; // 1 USDC for normalization
const SLIPPAGE_PCT = 0; // slippage adjustment

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── CONTRACT ABI ───────────────
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

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8e8c7Aa09B6A2641CF6F90F643E76D3F6E6Ff73", // make sure checksum correct
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

// Safe getAmountsOut with error handling
async function getAmountOut(routerAddr, token, amountIn) {
  try {
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
      provider
    );
    const usdcAddress = await arbContract.USDC();
    const path = [usdcAddress, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch (err) {
    console.warn(`⚠️ getAmountsOut failed for token ${token.address} on router ${routerAddr}: ${err.message}`);
    return null; // indicate failure
  }
}

// ─────────────── CUMULATIVE PROFIT ───────────────
let cumulativeProfit = 0;

// Safe execute trade with try/catch and callStatic
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    // Dry-run via callStatic first
    try {
      await arbContract.callStatic.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
      );
    } catch (csErr) {
      console.warn(`⚠️ CallStatic failed for ${tokenAddr} | Buy:${buyRouter} Sell:${sellRouter}`);
      console.warn("💡 Debug info:", csErr);
      return; // skip trade
    }

    // Actual execution
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6),
      { gasLimit: 2_000_000 }
    );
    console.log(`⏳ Trade sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined: ${tx.hash} | block ${receipt.blockNumber}`);

    // Compute profit
    const usdcAddress = await arbContract.USDC();
    const usdc = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns (uint256)"], provider);
    const balanceAfter = await usdc.balanceOf(CONTRACT_ADDRESS);
    const netProfit = ethers.formatUnits(balanceAfter, 6) - amount;
    cumulativeProfit += netProfit;
    console.log(`💹 Net USDC change this tx: ${netProfit.toFixed(6)} USDC`);
    console.log(`📊 Cumulative profit this session: ${cumulativeProfit.toFixed(6)} USDC`);

  } catch (err) {
    console.error(`⚠️ Trade failed: ${err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          if (!buyOut || !sellOut) continue; // skip invalid routes

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;
          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct *= (1 - SLIPPAGE_PCT / 100);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (err) {
          console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}: ${err.message}`);
        }
      }
    }
  }
  console.log("🔍 Scan complete.\n");
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
