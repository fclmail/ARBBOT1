import { ethers } from "ethers";
import fs from "fs";

// ----------------------------
// CONFIGURATION
// ----------------------------

// Load from environment variables (GitHub Secrets)
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;

// Vault contract address and USDC token
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

// Routers to scan (example: QuickSwap, SushiSwap, ApeSwap)
const ROUTERS = [
  "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff", // QuickSwap
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", // SushiSwap
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607", // ApeSwap
];

// Tokens to scan
const TOKENS = [
  "0xd6df932a45c0f255f85145f286ea0b292b21c90b", // AAVE
  "0x172370d5cd63279efa6d502dab29171933a610af", // CRV
  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", // LINK
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
];

// Arbitrage thresholds
const MIN_PROFIT_USDC = 10; // smallest profit to execute

// Vault ABI (simplified)
const VAULT_ABI = [
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",
  "function approveRouter(address router,address token) external",
  "function balanceOf(address) view returns(uint256)"
];

// ERC20 ABI (simplified)
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

// ----------------------------
// SETUP PROVIDER & WALLET
// ----------------------------
if (!PRIVATE_KEY || !RPC_URL) {
  throw new Error("Missing PRIVATE_KEY or RPC_URL environment variable");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Vault contract
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ----------------------------
// HELPER FUNCTIONS
// ----------------------------

// Approve a token for a router via vault (once per router/token)
async function approveRouter(router, token) {
  try {
    console.log(`Approving router ${router} for token ${token} via vault...`);
    const tx = await vault.approveRouter(router, token);
    await tx.wait();
    console.log(`✅ Approved ${token} for router ${router}`);
  } catch (err) {
    console.log(`⚠️ Approval failed for ${token} on router ${router}:`, err.reason || err.message);
  }
}

// Mock profit calculation function (replace with real logic)
async function getExpectedProfit(token, buyRouter, sellRouter) {
  // For demo: return a small random profit
  return Math.floor(Math.random() * 1000) / 10000; // 0.0000-0.0999 USDC
}

// Execute arbitrage via vault
async function executeArb(token, buyRouter, sellRouter, amountInUSDC) {
  const deadline = Math.floor(Date.now() / 1000) + 60; // 1 min
  const minTokenOut = 1; // off-chain calculated
  const minUSDCOut = 1;  // off-chain calculated

  const beforeBal = await vault.USDC().then(addr => {
    const usdc = new ethers.Contract(addr, ERC20_ABI, provider);
    return usdc.balanceOf(VAULT_ADDRESS);
  });

  try {
    console.log(`Executing arbitrage ${token} | ${buyRouter}→${sellRouter} | amount=${amountInUSDC}`);
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountInUSDC,
      minTokenOut,
      minUSDCOut,
      deadline
    );
    await tx.wait();

    const afterBal = await vault.USDC().then(addr => {
      const usdc = new ethers.Contract(addr, ERC20_ABI, provider);
      return usdc.balanceOf(VAULT_ADDRESS);
    });

    const profit = afterBal - beforeBal;
    console.log(`✅ Arbitrage executed, profit: ${ethers.formatUnits(profit, 6)} USDC`);
  } catch (err) {
    console.log(`⚠️ Arbitrage failed for ${token}:`, err.reason || err.message);
  }
}

// ----------------------------
// MAIN LOOP
// ----------------------------
async function main() {
  console.log("🚀 Live arbitrage runner started");
  const vaultOwner = await vault.owner();
  console.log("Vault owner:", vaultOwner);

  for (const token of TOKENS) {
    for (const buyRouter of ROUTERS) {
      for (const sellRouter of ROUTERS) {
        if (buyRouter === sellRouter) continue;

        const expectedProfit = await getExpectedProfit(token, buyRouter, sellRouter);

        console.log(`${token} | ${buyRouter}→${sellRouter} | expected profit=${expectedProfit} USDC`);

        if (expectedProfit * 1e6 >= MIN_PROFIT_USDC) {
          // Approve router first
          await approveRouter(buyRouter, token);
          await approveRouter(sellRouter, token);

          // Execute arbitrage
          await executeArb(token, buyRouter, sellRouter, expectedProfit * 1e6);
        }
      }
    }
  }
}

// Run
main().catch(err => console.error(err));
