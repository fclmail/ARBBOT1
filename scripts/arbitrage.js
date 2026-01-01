// scripts/arbitrage.js
// ---------------------------------------------------------
// POLYGON ARBITRAGE BOT
// Full Ethers v6 version with signer fixes & 0.01 USDC trade

import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ----------------------------
// CONFIG / ENV
// ----------------------------
const POLYGON_RPC = process.env.POLYGON_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Vault contract
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const VAULT_ABI = JSON.parse(fs.readFileSync("./abis/ArbVault.json"));

// Routers
const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"; // SushiSwap
const ROUTER_ABI = JSON.parse(fs.readFileSync("./abis/IUniswapV2Router.json"));

// Token addresses
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS; // Token to arbitrage

// ----------------------------
// INIT PROVIDER & SIGNER
// ----------------------------
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ----------------------------
// CONNECT CONTRACTS WITH SIGNER
// ----------------------------
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, wallet);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, wallet);

// ----------------------------
// TRADE PARAMETERS
// ----------------------------
const TRADE_AMOUNT_USDC = ethers.parseUnits("0.01", 6); // 0.01 USDC
const MIN_PROFIT_USDC = ethers.parseUnits("0.0005", 6); // 0.0005 USDC for testing

// ----------------------------
// DEX PATHS
// ----------------------------
const dexPairs = [
  { buy: quickRouter, sell: sushiRouter, name: "Quick ➜ Sushi" },
  { buy: sushiRouter, sell: quickRouter, name: "Sushi ➜ Quick" }
];

// ----------------------------
// UTILITY FUNCTIONS
// ----------------------------
async function getVaultBalance() {
  return await vault.USDC().then(token => token.balanceOf(vault.target));
}

// ----------------------------
// MAIN LOOP
// ----------------------------
async function runArb() {
  console.log("⏱ Polygon Arb Bot Started");

  const vaultBal = await getVaultBalance();
  console.log("🏦 Vault USDC:", ethers.formatUnits(vaultBal, 6));

  for (const dex of dexPairs) {
    console.log(`🔍 ${dex.name}`);

    try {
      // Execute arbitrage
      const tx = await vault.executeArbitrage(
        dex.buy.target,
        dex.sell.target,
        TOKEN_ADDRESS,
        TRADE_AMOUNT_USDC,
        MIN_PROFIT_USDC
      );

      const receipt = await tx.wait();
      console.log(`✅ Executed: ${dex.name} | TxHash: ${receipt.transactionHash}`);
    } catch (err) {
      console.error(`⚠️ Execution failed: ${err.message}`);
    }
  }
}

// ----------------------------
// START BOT
// ----------------------------
(async () => {
  try {
    await runArb();
  } catch (err) {
    console.error("Fatal error:", err);
  }
})();
