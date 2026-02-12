import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

/* =====================================
   LOAD ENVIRONMENT VARIABLES
===================================== */

const {
  RPC_URL,
  PRIVATE_KEY,
  ARB_CONTRACT_ADDRESS
} = process.env;

/* =====================================
   VALIDATE ENV VARIABLES
===================================== */

function validateEnv() {
  const missing = [];

  if (!RPC_URL) missing.push("RPC_URL");
  if (!PRIVATE_KEY) missing.push("PRIVATE_KEY");
  if (!ARB_CONTRACT_ADDRESS) missing.push("ARB_CONTRACT_ADDRESS");

  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach((v) => console.error(`   - ${v}`));
    process.exit(1);
  }
}

validateEnv();

/* =====================================
   SETUP PROVIDER & WALLET
===================================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =====================================
   CONFIG
===================================== */

// Example: 10,000 USDC (6 decimals)
const FLASH_AMOUNT = ethers.parseUnits("10000", 6);

/* =====================================
   CONTRACT ABI
   Replace with your real ABI if needed
===================================== */

const arbAbi = [
  "function executeArbitrage(uint256 amount) external"
];

const arbContract = new ethers.Contract(
  ARB_CONTRACT_ADDRESS,
  arbAbi,
  wallet
);

/* =====================================
   MAIN EXECUTION
===================================== */

async function main() {
  try {
    console.log("=================================");
    console.log("🚀 ARB BOT STARTED");
    console.log("Wallet:", wallet.address);
    console.log("Contract:", ARB_CONTRACT_ADDRESS);
    console.log("Flash Amount:", FLASH_AMOUNT.toString());
    console.log("=================================");

    // Check wallet balance first
    const balance = await provider.getBalance(wallet.address);
    console.log("Wallet ETH Balance:", ethers.formatEther(balance));

    if (balance === 0n) {
      console.error("❌ Wallet has 0 ETH for gas.");
      process.exit(1);
    }

    // Send transaction
    const tx = await arbContract.executeArbitrage(FLASH_AMOUNT);

    console.log("⏳ Transaction submitted:");
    console.log("Tx Hash:", tx.hash);

    const receipt = await tx.wait();

    console.log("✅ Transaction confirmed!");
    console.log("Block:", receipt.blockNumber);
    console.log("Gas Used:", receipt.gasUsed.toString());

  } catch (error) {
    console.error("❌ Arbitrage execution failed:");
    console.error(error);
    process.exit(1);
  }
}

main();
