import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// --- Load environment variables ---
const {
  RPC_URL,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  BUY_ROUTERS,   // expect JSON array string
  SELL_ROUTERS,  // expect JSON array string
  TOKEN,
  AMOUNT_IN_HUMAN
} = process.env;

// --- Validate environment ---
if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS || !BUY_ROUTERS || !SELL_ROUTERS || !TOKEN || !AMOUNT_IN_HUMAN) {
  console.error("Missing required environment variables!");
  process.exit(1);
}

// --- Parse routers ---
let buyRouters, sellRouters;
try {
  buyRouters = JSON.parse(BUY_ROUTERS);
  sellRouters = JSON.parse(SELL_ROUTERS);
  if (!Array.isArray(buyRouters) || !Array.isArray(sellRouters)) {
    throw new Error("Routers are not valid arrays");
  }
} catch (err) {
  console.error("Error parsing router lists:", err.message);
  process.exit(1);
}

// --- Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// --- Load ABI ---
const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
const abiJSON = fs.readFileSync(abiPath, "utf-8");
const abi = JSON.parse(abiJSON);

// --- Contract instance ---
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

// --- Convert human-readable amount to smallest unit ---
let AMOUNT_IN;
try {
  AMOUNT_IN = ethers.parseUnits(AMOUNT_IN_HUMAN, 6); // USDC.e has 6 decimals
  console.log("Parsed AMOUNT_IN:", AMOUNT_IN.toString());
} catch (err) {
  console.error("Error parsing AMOUNT_IN_HUMAN:", err.message);
  process.exit(1);
}

// --- Execute arbitrage across all router pairs ---
async function main() {
  console.log("🚀 Starting arbitrage...");
  console.log("Token:", TOKEN);
  console.log("Amount:", AMOUNT_IN_HUMAN, "USDC.e");
  
  for (const buyRouter of buyRouters) {
    for (const sellRouter of sellRouters) {
      if (buyRouter.toLowerCase() === sellRouter.toLowerCase()) continue; // skip same DEX
      try {
        console.log(`Trying arbitrage: Buy ${buyRouter}, Sell ${sellRouter}`);
        const tx = await contract.executeArbitrage(buyRouter, sellRouter, TOKEN, AMOUNT_IN);
        console.log(`Transaction sent! Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`Transaction confirmed! Receipt: ${receipt.transactionHash}`);
      } catch (err) {
        console.error(`Failed for pair Buy ${buyRouter}, Sell ${sellRouter}:`, err.message);
      }
    }
  }
  console.log("✅ Arbitrage loop finished.");
}

// --- Run ---
main();
