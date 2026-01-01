// scripts/arbitrage.js
// ============================================================
// Polygon Arbitrage Bot
// Uses ArbVault.sol contract to enforce minimum profit
// Handles Sushi/Quick/Uniswap style routers
// Fixes ENOENT, vault balance, and execution revert issues
// ============================================================

import { ethers } from "ethers";

// ---------------------- CONFIG -----------------------------
const RPC_URL = "https://polygon-rpc.com"; // Polygon Mainnet RPC
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY; // bot wallet key
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19"; // deployed ArbVault
const VAULT_MIN_PROFIT_USDC = 10000; // 0.01 USDC with 6 decimals
const TRADE_AMOUNT_USDC = 10000; // 0.01 USDC (6 decimals)
const DEADLINE_OFFSET = 60; // seconds

// ---------------------- INLINE ABIs ------------------------

// Minimal ArbVault ABI (core functions)
const VAULT_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minReturnUSDC) external",
  "function USDC() view returns (address)"
];

// Minimal UniswapV2 Router ABI
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts)",
  "function getAmountsOut(uint256 amountIn,address[] calldata path) view returns (uint256[] memory amounts)"
];

// ERC20 ABI (minimal)
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)"
];

// ---------------------- PROVIDER & WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// Vault contract instance
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ---------------------- UTILITY FUNCTIONS -----------------
async function getUSDCBalance() {
  const usdcAddress = await vault.USDC();
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return bal;
}

function usdc(amount) {
  // helper to convert decimals if needed
  return ethers.parseUnits(amount.toString(), 6);
}

// ---------------------- ARBITRAGE EXECUTION --------------
async function executeArb(buyRouter, sellRouter, token, amountInUSDC, minReturnUSDC) {
  try {
    const vaultBalance = await getUSDCBalance();

    if (vaultBalance < amountInUSDC) {
      console.log("❌ Vault balance insufficient for trade");
      return;
    }

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountInUSDC,
      minReturnUSDC,
      {
        gasLimit: 500_000
      }
    );
    console.log(`✅ Arbitrage tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`🎯 Arbitrage confirmed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.log("⚠️ Execution failed:", err.message);
  }
}

// ---------------------- EXAMPLE SCAN & TRADE ----------------
async function scanAndTrade() {
  const buyRouter = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // Sushi
  const sellRouter = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap
  const token = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"; // Example token

  // Set trade amount to 0.01 USDC
  const amountIn = usdc(0.01); // 0.01 USDC
  const minReturn = usdc(0.0095); // slightly less to allow slippage

  console.log("🏦 Vault USDC:", (await getUSDCBalance() / 1e6).toFixed(6));
  console.log("🔍 Attempting arbitrage...");

  await executeArb(buyRouter, sellRouter, token, amountIn, minReturn);
}

// ---------------------- MAIN LOOP -------------------------
async function main() {
  console.log(`⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);

  while (true) {
    try {
      await scanAndTrade();
      await new Promise(r => setTimeout(r, 10_000)); // 10s delay
    } catch (err) {
      console.error("Error in main loop:", err);
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
}

main();
