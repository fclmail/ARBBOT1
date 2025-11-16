// scripts/arbitrage-dryrun.js
import { ethers } from "ethers";
import abi from "../artifacts/ArbContract.json"; // replace with your ABI path

// === CONFIG ===
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const DRY_RUN = true; // force dry run
const TRADE_AMOUNT_USDC = 100; // USDC per trade
const TOKEN_LIST = [
  { symbol: "CRV", address: "0x...CRV_ADDRESS..." },
  { symbol: "LINK", address: "0x...LINK_ADDRESS..." },
  { symbol: "WBTC", address: "0x...WBTC_ADDRESS..." },
];
const ROUTERS = [
  { name: "QuickSwap", address: "0xA5E0829CaCEd8fFDD4De3C43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1B02da8CB0d097eB8D57A175b88c7D8b47997506" },
  { name: "ApeSwap", address: "0xc0788A3aD43d79aa53B09c2EaCc313A787d1d607" },
  { name: "Dfyn", address: "0xd6DF932A45C0f255f85145f286ea0b292B21C90B" },
];

// === PROVIDER AND CONTRACT ===
const provider = new ethers.JsonRpcProvider(RPC_URL);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

let cumulativeProfit = 0;

// Helper to simulate a trade
async function simulateTrade(buyRouter, sellRouter, token, amount) {
  try {
    if (DRY_RUN) {
      console.log(`🧪 DRY RUN: Buy ${token.symbol} via ${buyRouter.name} | Sell via ${sellRouter.name} | Amount: ${amount} USDC`);
    }

    // Call static simulation
    const parsedAmount = ethers.parseUnits(amount.toString(), 6);
    const result = await arbContract.callStatic.executeArbitrage(
      buyRouter.address,
      sellRouter.address,
      token.address,
      parsedAmount
    );

    // Calculate profit in USDC
    const profit = Number(ethers.formatUnits(result, 6)) - amount;
    cumulativeProfit += profit;

    console.log(`💹 Simulated Profit: ${profit.toFixed(6)} USDC | Cumulative: ${cumulativeProfit.toFixed(6)} USDC`);
  } catch (err) {
    console.log(`⚠️ Simulation failed for ${token.symbol} ${buyRouter.name}->${sellRouter.name}: ${err.message}`);
  }
}

// Main loop
async function main() {
  console.log("🚀 Starting Dry-Run Arb Bot");
  console.log(`🔗 Contract: ${CONTRACT_ADDRESS}`);
  console.log("🔍 Scanning for arbitrage opportunities...\n");

  while (true) {
    for (let token of TOKEN_LIST) {
      for (let buyRouter of ROUTERS) {
        for (let sellRouter of ROUTERS) {
          if (buyRouter.address === sellRouter.address) continue;
          await simulateTrade(buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
        }
      }
    }

    // Delay between scans (optional)
    await new Promise((resolve) => setTimeout(resolve, 10000)); // 10s
  }
}

main().catch((e) => console.error(e));
