// scripts/arbitrage.js
import 'dotenv/config';
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// --- Load Environment Variables ---
const {
  RPC_URL,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  AMOUNT_IN,
  MIN_PROFIT_PERCENT,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN
} = process.env;

// --- Validate Required Values ---
function validateEnv() {
  const required = { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, AMOUNT_IN, MIN_PROFIT_PERCENT, BUY_ROUTER, SELL_ROUTER, TOKEN };
  for (const [key, value] of Object.entries(required)) {
    if (!value || value.trim() === "") {
      console.error(`❌ Missing environment variable: ${key}`);
      process.exit(1);
    }
  }
}

// --- Load ABI ---
function loadAbi() {
  const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
  if (!fs.existsSync(abiPath)) {
    console.error(`❌ ABI file not found at: ${abiPath}`);
    process.exit(1);
  }
  try {
    const abiJSON = fs.readFileSync(abiPath, "utf-8");
    return JSON.parse(abiJSON);
  } catch (err) {
    console.error("❌ Error parsing ABI JSON:", err.message);
    process.exit(1);
  }
}

// --- Main Function ---
async function main() {
  console.log("🚀 Starting Polygon Arbitrage Bot...");

  validateEnv();
  const abi = loadAbi();

  try {
    // --- Setup Provider and Wallet ---
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    console.log(`✅ Connected to Polygon RPC as ${await wallet.getAddress()}`);

    // --- Setup Contract ---
    const contract = new ethers.Contract(CONTRACT_ADDRESS, abi.abi, wallet);

    // --- Parse Amounts ---
    const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6); // USDC.e 6 decimals
    const minProfitPercent = parseFloat(MIN_PROFIT_PERCENT); // 0.0002 for 0.02%

    // --- Clean router addresses ---
    const buyRouter = BUY_ROUTER.trim();
    const sellRouter = SELL_ROUTER.trim();
    const token = TOKEN.trim();

    console.log("🔍 Input Parameters:");
    console.log({
      token,
      buyRouter,
      sellRouter,
      AMOUNT_IN,
      amountInParsed: amountInParsed.toString(),
      minProfitPercent
    });

    // --- Execute Arbitrage ---
    console.log("💥 Sending flash loan arbitrage transaction...");
    const tx = await contract.executeArbitrage(buyRouter, sellRouter, token, amountInParsed);
    console.log(`📤 Transaction submitted! Hash: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

    // Optional: Calculate estimated profit in USDC
    const postBalance = await contract.provider.getBalance(contract.target);
    console.log(`💰 Estimated profit (contract balance): ${postBalance.toString()}`);
  } catch (err) {
    console.error("⚠️ Error executing flash loan arbitrage:", err);
    process.exit(1);
  }
}

// --- Run ---
main();
