// scripts/arbitrage.js

import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// ======================== CONFIG ========================

// Load ABIs dynamically to avoid ESM import issues
const VaultABI = JSON.parse(fs.readFileSync(path.resolve("./abis/VaultArbitrageEnforcer.json"), "utf8"));
const ERC20ABI = JSON.parse(fs.readFileSync(path.resolve("./abis/IERC20.json"), "utf8"));

// Replace these with your deployed contract and router addresses
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // e.g., https://polygon-rpc.com

// Example routers (must be valid checksum addresses)
const ROUTERS = [
  "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff", // QuickSwap
  "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607", // SushiSwap
  "0xa102072A4C07F06EC3B4900FDcC4C7B80b6C57429"  // Dfyn
];

// USDC token address (Polygon)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const MIN_PROFIT = ethers.utils.parseUnits("0.000001", 6); // 0.000001 USDC

// ======================== PROVIDER & WALLET ========================

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ======================== CONTRACT INSTANCES ========================

const vault = new ethers.Contract(VAULT_CONTRACT, VaultABI, wallet);
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20ABI, wallet);

// ======================== HELPER FUNCTIONS ========================

async function safeApprove(token, spender, amount) {
  try {
    const allowance = await token.allowance(wallet.address, spender);
    if (allowance < amount) {
      console.log(`[${new Date().toISOString()}] Approving ${ethers.formatUnits(amount, 6)} USDC for router ${spender}`);
      const tx = await token.approve(spender, amount);
      await tx.wait();
      console.log(`[${new Date().toISOString()}] Router approved: ${spender} (Tx: ${tx.hash})`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Approval failed for ${spender}:`, err.message);
  }
}

async function executeArbSafe(buyRouter, sellRouter, amountIn, pathToToken, pathToUSDC) {
  try {
    const before = await usdc.balanceOf(wallet.address);

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      amountIn,
      pathToToken,
      pathToUSDC,
      Math.floor(Date.now() / 1000) + 60 * 5 // 5 min deadline
    );

    const receipt = await tx.wait();
    const after = await usdc.balanceOf(wallet.address);
    const profit = after - before;

    console.log(`[${new Date().toISOString()}] Arbitrage executed: Profit ${ethers.formatUnits(profit, 6)} USDC`);
    return profit;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] 💤 Skipped ${buyRouter} -> ${sellRouter}:`, err.message);
  }
}

// ======================== MAIN LOOP ========================

async function main() {
  console.log("Starting arbitrage bot…");
  console.log(`✔ Wallet address: ${wallet.address}`);
  console.log(`Minimum profit enforced: ${ethers.formatUnits(MIN_PROFIT, 6)} USDC`);

  // Approve USDC for all routers
  for (let router of ROUTERS) {
    const checksumRouter = ethers.getAddress(router); // ensures checksum
    await safeApprove(usdc, checksumRouter, ethers.utils.parseUnits("1000000", 6));
  }

  console.log("✅ Setup complete. Starting scan loop…");

  while (true) {
    for (let buy of ROUTERS) {
      for (let sell of ROUTERS) {
        if (buy === sell) continue;
        const checksumBuy = ethers.getAddress(buy);
        const checksumSell = ethers.getAddress(sell);

        // Example path: USDC -> WETH -> USDC (replace with real tokens)
        const pathToToken = [USDC_ADDRESS, "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"]; // USDC -> WETH
        const pathToUSDC = [pathToToken[pathToToken.length - 1], USDC_ADDRESS];           // WETH -> USDC

        const amountIn = ethers.utils.parseUnits("10", 6); // 10 USDC

        await executeArbSafe(checksumBuy, checksumSell, amountIn, pathToToken, pathToUSDC);
      }
    }
    console.log(`[${new Date().toISOString()}] Cycle complete. Restarting in 5s...`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(err => console.error(err));
