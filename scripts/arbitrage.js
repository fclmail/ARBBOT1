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

  // --- Setup Provider and Wallet ---
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`✅ Connected to Polygon RPC as ${await wallet.getAddress()}`);

  // --- Setup Contract ---
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi.abi, wallet);

  // --- Clean & validate router addresses ---
  const buyRouter = BUY_ROUTER.trim().replace(/\s+/g, "");
  const sellRouter = SELL_ROUTER.trim().replace(/\s+/g, "");
  const token = TOKEN.trim();

  if (!ethers.isAddress(buyRouter) || !ethers.isAddress(sellRouter) || !ethers.isAddress(token)) {
    console.error("❌ Invalid address detected:", { buyRouter, sellRouter, token });
    process.exit(1);
  }

  // --- Parse amount ---
  const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6); // USDC.e has 6 decimals

  console.log("🔍 Input Parameters:");
  console.log({ token, buyRouter, sellRouter, AMOUNT_IN, ParsedAmount: amountInParsed.toString() });

  // --- Execute Arbitrage via Flash Loan ---
  try {
    console.log("💥 Sending flash loan arbitrage transaction...");

    const tx = await contract.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountInParsed,
      { gasLimit: 500_000 } // adjust as needed
    );

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
