import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

/* ================================
   CONFIG
================================ */

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Example token (USDC style 6 decimals)
const FLASH_AMOUNT = ethers.parseUnits("10000", 6);

// Replace with your deployed arbitrage contract
const ARB_CONTRACT_ADDRESS = process.env.ARB_CONTRACT_ADDRESS;

/* ================================
   BASIC SAFETY CHECKS
================================ */

if (!RPC_URL) {
  throw new Error("RPC_URL not set in environment variables");
}

if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY not set in environment variables");
}

if (!ARB_CONTRACT_ADDRESS) {
  throw new Error("ARB_CONTRACT_ADDRESS not set in environment variables");
}

/* ================================
   SETUP PROVIDER + WALLET
================================ */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================================
   CONTRACT ABI (MINIMAL EXAMPLE)
   Replace with your real ABI
================================ */

const arbAbi = [
  "function executeArbitrage(uint256 amount) external"
];

const arbContract = new ethers.Contract(
  ARB_CONTRACT_ADDRESS,
  arbAbi,
  wallet
);

/* ================================
   MAIN EXECUTION
================================ */

async function main() {
  try {
    console.log("🚀 Starting arbitrage bot...");
    console.log("Wallet:", wallet.address);
    console.log("Flash Amount:", FLASH_AMOUNT.toString());

    const tx = await arbContract.executeArbitrage(FLASH_AMOUNT);

    console.log("⏳ Transaction sent:", tx.hash);

    const receipt = await tx.wait();

    console.log("✅ Arbitrage executed in block:", receipt.blockNumber);
  } catch (error) {
    console.error("❌ Error executing arbitrage:");
    console.error(error);
    process.exit(1);
  }
}

main();
