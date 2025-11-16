// scripts/arbitrage.js

import { ethers } from "ethers";
import { getArbitrageOpportunities } from "../arb-lib.js"; // Replace with your library

// -------------------------
// CONFIGURATION
// -------------------------

// Wallet private key from environment variable (GitHub Secret)
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) {
  throw new Error("WALLET_PRIVATE_KEY not set in environment variables!");
}

// Polygon RPC provider (default or from env)
const PROVIDER_URL = process.env.POLYGON_RPC || "https://polygon-rpc.com/";
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);

// Connect wallet
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// Arbitrage contract
const CONTRACT_ADDRESS = process.env.ARB_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const CONTRACT_ABI = [
  "function executeArbitrage(address tokenIn, address tokenOut, uint256 amount) external"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

// -------------------------
// MAIN FUNCTION
// -------------------------

async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  console.log("👤 Contract owner:", wallet.address);

  // Fetch arbitrage opportunities
  let opportunities;
  try {
    opportunities = await getArbitrageOpportunities();
    if (!opportunities || opportunities.length === 0) {
      console.log("🔍 No arbitrage opportunities found at this time.");
      return;
    }
  } catch (err) {
    console.error("⚠️ Error fetching arbitrage opportunities:", err.message);
    return;
  }

  console.log(`🔍 Found ${opportunities.length} opportunities`);

  // Loop through opportunities
  for (let i = 0; i < opportunities.length; i++) {
    const opp = opportunities[i];

    if (!opp || !opp.buy || !opp.sell) {
      console.log(`⚠️ Skipping undefined opportunity at index ${i}`);
      continue;
    }

    console.log(`🚨 Opportunity #${i + 1}: Buy:${opp.buy.dex} @ ${opp.buy.price} → Sell:${opp.sell.dex} @ ${opp.sell.price} | Profit: ${opp.profit.toFixed(6)} USDC`);

    // Dry-run mode: just log
    if (process.env.DRY_RUN === "true") {
      console.log("⚡ Dry-run enabled, not executing trade.");
      continue;
    }

    // Estimate gas and check wallet balance
    try {
      const gasEstimate = await contract.estimateGas.executeArbitrage(
        opp.buy.tokenAddress,
        opp.sell.tokenAddress,
        opp.amount
      );

      const gasPrice = await provider.getFeeData();
      const txCost = gasEstimate * (gasPrice.maxFeePerGas || gasPrice.gasPrice);

      const balance = await wallet.getBalance();
      if (balance.lt(txCost)) {
        console.log("⚠️ Skipping trade: insufficient funds for gas", ethers.formatEther(balance), "ETH");
        continue;
      }

      // Execute trade
      const tx = await contract.executeArbitrage(
        opp.buy.tokenAddress,
        opp.sell.tokenAddress,
        opp.amount
      );
      console.log("✅ Trade submitted:", tx.hash);

      const receipt = await tx.wait();
      console.log("✅ Trade confirmed in block", receipt.blockNumber);
    } catch (err) {
      console.error("⚠️ Trade failed:", err.message);
      continue; // skip to next opportunity
    }
  }
}

// -------------------------
// RUN
// -------------------------

main()
  .then(() => console.log("🏁 Arbitrage scan completed"))
  .catch(err => console.error("⚠️ Unexpected error:", err));
