// ─────────────────────────────────────────────
// 🔹 Polygon Mainnet Flash Arbitrage Live Bot
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // wallet with funds for gas
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; 
const TRADE_AMOUNT_USDC = 100; // updated
const DRY_RUN = false; // live mode

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── CONTRACT SETUP ───────────────
const arbAbi = [ /* use your full ABI here */ ];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS & TOKENS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── OPPORTUNITY LIST ───────────────
// Hardcoded profitable combos based on dry-run
const opportunities = [
  { token: tokens.CRV, buyRouter: routers.SushiSwap, sellRouter: routers.ApeSwap },
  { token: tokens.LINK, buyRouter: routers.QuickSwap, sellRouter: routers.SushiSwap },
  // add more if verified profitable
];

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

let cumulativeProfit = 0;

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Live Arbitrage Bot Started");
  console.log("Signer:", wallet.address);

  while (true) {
    for (const opp of opportunities) {
      try {
        // 1️⃣ Simulate trade using callStatic
        await arbContract.callStatic.executeArbitrage(
          opp.buyRouter,
          opp.sellRouter,
          opp.token.address,
          ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
        );

        // 2️⃣ Send real transaction if simulation passes
        if (!DRY_RUN) {
          const tx = await arbContract.executeArbitrage(
            opp.buyRouter,
            opp.sellRouter,
            opp.token.address,
            ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
          );
          const receipt = await tx.wait();

          // 3️⃣ Calculate profit based on balance change
          const usdcAddr = await arbContract.USDC();
          const usdcContract = new ethers.Contract(usdcAddr, [
            "function balanceOf(address) view returns (uint256)"
          ], provider);

          const balance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
          cumulativeProfit = Number(ethers.formatUnits(balance, 6));

          console.log(`🚨 PROFIT TRADE EXECUTED: ${opp.token.address}`);
          console.log(`💰 Contract USDC balance: ${fmt(cumulativeProfit)} USDC`);
        } else {
          console.log(`🧪 DRY RUN: ${opp.token.address} would be profitable, skipping live tx`);
        }

      } catch (err) {
        console.log(`❌ Trade not profitable or failed: ${opp.token.address}`, err.reason || err.message);
      }
    }

    // 5-second delay between scans
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);

