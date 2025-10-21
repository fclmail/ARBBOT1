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
  TOKEN,
  AMOUNT_IN,
  MIN_PROFIT_PERCENT,
  BUY_ROUTER,
  SELL_ROUTER
} = process.env;

// --- Validate Required Values ---
function validateEnv() {
  const required = { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, TOKEN, AMOUNT_IN, MIN_PROFIT_PERCENT, BUY_ROUTER, SELL_ROUTER };
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
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    console.log(`✅ Connected to Polygon RPC as ${await wallet.getAddress()}`);

    const contract = new ethers.Contract(CONTRACT_ADDRESS, abi.abi, wallet);

    const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6); // USDC decimals
    const minProfitPercent = parseFloat(MIN_PROFIT_PERCENT);

    // Clean router addresses
    const buyRouter = BUY_ROUTER.trim();
    const sellRouter = SELL_ROUTER.trim();

    console.log("🔍 Input Parameters:");
    console.log({ token: TOKEN, buyRouter, sellRouter, AMOUNT_IN, amountInParsed: amountInParsed.toString(), minProfitPercent });

    // --- ESTIMATE PROFIT --- //
    // Fetch current balances after simulated swap (read-only)
    // Here we call a custom contract view function "simulateArbitrage" (needs to be implemented on-chain)
    // Alternatively, you can estimate using off-chain price oracles
    let estimatedProfit = 0; // Placeholder for simulation
    // Example: for demo, assume 0.02% profit of AMOUNT_IN
    estimatedProfit = Number(AMOUNT_IN) * minProfitPercent;

    console.log(`💰 Estimated profit: $${estimatedProfit.toFixed(4)}`);
    if (estimatedProfit < Number(AMOUNT_IN) * minProfitPercent) {
      console.log(`⚠️ Estimated profit below MIN_PROFIT_PERCENT. Skipping execution.`);
      return;
    }

    // --- Execute Arbitrage --- //
    console.log("💥 Sending flash loan arbitrage transaction...");
    const tx = await contract.executeArbitrage(buyRouter, sellRouter, TOKEN.trim(), amountInParsed);
    console.log(`📤 Transaction submitted! Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.error("⚠️ Error executing flash loan arbitrage:", err);
    process.exit(1);
  }
}

// --- Run ---
main();

