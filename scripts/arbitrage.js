import { ethers } from "ethers";
import fs from "fs";

// --- CONFIG ---
const RPC_URL = "https://polygon-rpc.com"; // Replace with your provider
const PRIVATE_KEY = "YOUR_WALLET_PRIVATE_KEY"; // Owner of the vault
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC

// Routers
const ROUTERS = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "ApeSwap", address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
];

// Tokens to scan (example)
const TOKENS = [
  { symbol: "CRV", address: "0x172370d5cd63279efa6d502dab29171933a610af" },
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" }
];

// Vault ABI (only required functions)
const VAULT_ABI = [
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function approveRouter(address router, address token) external",
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountInUSDC, uint256 minTokenOut, uint256 minUSDCOut, uint256 deadline) external",
  "function balanceOf(address token) view returns (uint256)"
];

// ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// --- PROVIDER & SIGNER ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// --- CONTRACTS ---
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

// --- TRACK APPROVALS ---
const approvedTokens = {};

// --- HELPERS ---
async function approveVaultRouter(tokenAddress, routerAddress) {
  try {
    console.log(`Approving router ${routerAddress} for token ${tokenAddress} via vault`);
    const tx = await vault.approveRouter(routerAddress, tokenAddress, { gasLimit: 150_000 });
    await tx.wait();
    console.log(`Router approved successfully`);
  } catch (err) {
    console.error(`Approval failed for token ${tokenAddress} on router ${routerAddress}:`, err.reason || err);
  }
}

async function executeArb(buyRouter, sellRouter, tokenAddress, amountInUSDC, minTokenOut = 0, minUSDCOut = 0) {
  try {
    const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // 10 min
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddress,
      amountInUSDC,
      minTokenOut,
      minUSDCOut,
      deadline,
      { gasLimit: 500_000 }
    );
    await tx.wait();
    console.log(`✅ Arbitrage executed: token=${tokenAddress} | buy=${buyRouter} sell=${sellRouter}`);
  } catch (err) {
    console.error(`⚠️ Arbitrage failed for token ${tokenAddress}:`, err.reason || err);
  }
}

async function scanTokens() {
  console.log("🔍 Scanning all tokens & routers...");

  const vaultUSDCBalance = await usdc.balanceOf(VAULT_ADDRESS);
  console.log(`🏦 Vault USDC Balance: ${ethers.formatUnits(vaultUSDCBalance, 6)} USDC`);

  for (const token of TOKENS) {
    for (const buy of ROUTERS) {
      for (const sell of ROUTERS) {
        if (buy.address === sell.address) continue;

        // --- APPROVE ROUTERS VIA VAULT ---
        if (!approvedTokens[token.address]) approvedTokens[token.address] = [];

        for (const router of [buy.address, sell.address]) {
          if (!approvedTokens[token.address].includes(router)) {
            await approveVaultRouter(token.address, router);
            approvedTokens[token.address].push(router);
          }
        }

        // --- SIMULATE PROFIT ---
        const expectedProfit = Math.random() * 100; // Dummy, replace with real price fetch
        if (expectedProfit > 0.01) {
          console.log(`${token.symbol} | ${buy.name}→${sell.name} | expected profit=${expectedProfit.toFixed(6)} USDC`);
          // Execute arbitrage
          const amountInUSDC = ethers.parseUnits("1", 6); // Example amount
          await executeArb(buy.address, sell.address, token.address, amountInUSDC);
        }
      }
    }
  }
}

// --- MAIN LOOP ---
(async () => {
  console.log("🚀 Live arbitrage runner started");
  await scanTokens();

  // Re-scan every 60 seconds
  setInterval(scanTokens, 60 * 1000);
})();
