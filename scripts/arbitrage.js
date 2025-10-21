// scripts/arbitrage.js
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
  BUY_ROUTER,
  SELL_ROUTER
} = process.env;

// --- Validate Required Values ---
function validateEnv() {
  const required = { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, TOKEN, AMOUNT_IN, BUY_ROUTER, SELL_ROUTER };
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

    // --- Parse Amount ---
    const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6); // assuming USDC.e (6 decimals)

    // --- Clean and Validate Router Addresses ---
    const buyRouter = BUY_ROUTER.trim().replace(/\s+/g, "");
    const sellRouter = SELL_ROUTER.trim().replace(/\s+/g, "");

    if (!ethers.isAddress(buyRouter) || !ethers.isAddress(sellRouter)) {
      console.error("❌ Invalid router address detected:", { buyRouter, sellRouter });
      process.exit(1);
    }

    // --- Log Inputs ---
    console.log("🔍 Input Parameters:");
    console.log({
      TOKEN: TOKEN.trim(),
      BUY_ROUTER: buyRouter,
      SELL_ROUTER: sellRouter,
      AMOUNT_IN,
      ParsedAmount: amountInParsed.toString(),
    });

    // --- Execute Arbitrage ---
    console.log("💥 Executing arbitrage transaction...");
    const tx = await contract.executeArbitrage(buyRouter, sellRouter, TOKEN.trim(), amountInParsed);

    console.log(`📤 Transaction sent! Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.error("⚠️ Error executing arbitrage:", err);
    process.exit(1);
  }
}

// --- Run ---
main();
