import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// --- Load environment variables and trim whitespace ---
const {
  RPC_URL,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN
} = process.env;

// --- Validate environment ---
if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS || !BUY_ROUTER || !SELL_ROUTER || !TOKEN) {
  console.error("Missing required environment variables!");
  process.exit(1);
}

// --- Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(RPC_URL.trim());
const wallet = new ethers.Wallet(PRIVATE_KEY.trim(), provider);

// --- Load ABI ---
const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
const abiJSON = fs.readFileSync(abiPath, "utf-8");
const abi = JSON.parse(abiJSON);

// --- Contract instance ---
const contract = new ethers.Contract(CONTRACT_ADDRESS.trim(), abi, wallet);

// --- Convert human-readable amount to smallest unit ---
let AMOUNT_IN;
try {
  if (!AMOUNT_IN_HUMAN) throw new Error("AMOUNT_IN_HUMAN is not set in secrets!");
  AMOUNT_IN = ethers.parseUnits(AMOUNT_IN_HUMAN.trim(), 6); // USDC.e has 6 decimals
  console.log("Parsed AMOUNT_IN:", AMOUNT_IN.toString());
} catch (err) {
  console.error("Error parsing AMOUNT_IN_HUMAN:", err.message);
  process.exit(1);
}

// --- Execute arbitrage ---
async function main() {
  try {
    console.log("🚀 Starting arbitrage...");
    console.log({
      BUY_ROUTER: BUY_ROUTER.trim(),
      SELL_ROUTER: SELL_ROUTER.trim(),
      TOKEN: TOKEN.trim(),
      AMOUNT_IN: AMOUNT_IN.toString()
    });

    const tx = await contract.executeArbitrage(
      BUY_ROUTER.trim(),
      SELL_ROUTER.trim(),
      TOKEN.trim(),
      AMOUNT_IN
    );
    console.log("Transaction sent! Hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("Transaction confirmed! Receipt:", receipt.transactionHash);
  } catch (err) {
    console.error("⚠️ Error executing arbitrage:", err);
    process.exit(1);
  }
}

// --- Run ---
main();

