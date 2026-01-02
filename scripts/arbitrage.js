// scripts/arbitrage.js

import { ethers } from "ethers";

// ==========================
// CONFIGURATION
// ==========================
const RPC_URL = "https://polygon-rpc.com";           // Polygon RPC URL
const PRIVATE_KEY = "YOUR_PRIVATE_KEY_HERE";        // Replace with your private key
const CONTRACT_ADDRESS = "0xYourContractAddress";   // Replace with your deployed contract address
const DRY_RUN = true;                               // Set to false to execute trades
const SCAN_INTERVAL_MS = 5000;                      // 5 seconds between scans

// ABI for your contract (must include executeArbitrage)
const CONTRACT_ABI = [
  "function executeArbitrage(uint256 amount) public returns (bool)",
  "function getVaultBalance(address token) public view returns (uint256)"
];

// ==========================
// INITIALIZE PROVIDER & CONTRACT
// ==========================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

let arbContract;
try {
  arbContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

  if (!arbContract.executeArbitrage) {
    throw new Error("executeArbitrage function not found in contract ABI");
  }

  console.log("✅ Arbitrage contract initialized successfully");
} catch (err) {
  console.error("❌ Failed to initialize arbitrage contract:", err.message);
  process.exit(1);
}

// ==========================
// HELPER FUNCTIONS
// ==========================

// Get USDC balance from vault
async function getVaultBalance() {
  try {
    const balance = await arbContract.getVaultBalance("USDC"); // Adjust token string if needed
    return parseFloat(ethers.formatUnits(balance, 6)); // USDC has 6 decimals
  } catch (err) {
    console.error("❌ Error fetching vault balance:", err.message);
    return 0;
  }
}

// Get wallet MATIC balance
async function getWalletBalance() {
  try {
    const balance = await provider.getBalance(wallet.address);
    return parseFloat(ethers.formatEther(balance));
  } catch (err) {
    console.error("❌ Error fetching wallet balance:", err.message);
    return 0;
  }
}

// Simulate arbitrage calculation (replace with your real logic)
function calculateArbitrage(amountUSDC) {
  const buyTokens = 243028771375281820n; // example
  const sellUSDC = 92149n; // example (0.092149 USDC)
  const expectedProfit = -0.007851; // example

  return { buyTokens, sellUSDC, expectedProfit };
}

// ==========================
// ARBITRAGE ATTEMPT
// ==========================
async function attemptArbitrage() {
  const vaultBalance = await getVaultBalance();
  console.log(`🏦 Vault USDC: ${vaultBalance}`);

  const walletMatic = await getWalletBalance();
  console.log(`🏦 Wallet MATIC balance: ${walletMatic}`);

  const tradeAmount = 0.1; // USDC to use

  const { buyTokens, sellUSDC, expectedProfit } = calculateArbitrage(tradeAmount);

  console.log("🔍 Attempting arbitrage...");
  console.log(`💰 Expected buy: ${tradeAmount} USDC -> ${buyTokens} token`);
  console.log(`💵 Expected sell: ${buyTokens} token -> ${sellUSDC} USDC`);
  console.log(`💸 Expected profit: ${expectedProfit} USDC`);

  // Skip unprofitable trades
  if (expectedProfit <= 0) {
    console.log("❌ Skipping trade: not profitable");
    return;
  }

  // Dry-run safety
  if (DRY_RUN) {
    console.log("⚠️ Dry-run: transaction not executed");
    return;
  }

  // Execute trade safely
  try {
    const tx = await arbContract.executeArbitrage(
      ethers.parseUnits(tradeAmount.toString(), 6)
    );
    console.log(`✅ Transaction submitted: ${tx.hash}`);
    await tx.wait();
    console.log("✅ Arbitrage executed successfully");
  } catch (err) {
    console.error("❌ Transaction failed:", err.message);
  }
}

// ==========================
// MAIN LOOP
// ==========================
async function mainLoop() {
  console.log("⏱ Polygon Arb Bot Started");

  while (true) {
    try {
      await attemptArbitrage();
    } catch (err) {
      console.error("❌ Error in arbitrage loop:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
  }
}

// ==========================
// START BOT
// ==========================
mainLoop();
