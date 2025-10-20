#!/usr/bin/env node
import * as ethers from "ethers";
import { promises as fs } from "fs";
import path from "path";

// --- Load environment variables ---
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
if (!RPC_URL) {
  console.error("RPC_URL not defined!");
  process.exit(1);
}

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !BUY_ROUTER || !SELL_ROUTER || !TOKEN) {
  console.error("Missing required environment variables!");
  process.exit(1);
}

// --- Trim all inputs ---
const contractAddress = CONTRACT_ADDRESS.trim();
const buyRouter = BUY_ROUTER.trim();
const sellRouter = SELL_ROUTER.trim();
const token = TOKEN.trim();
const rpcUrl = RPC_URL.trim();

// --- Validate Ethereum addresses ---
function validateAddress(addr, name) {
  if (!ethers.isAddress(addr)) {
    console.error(`Invalid Ethereum address for ${name}:`, addr);
    process.exit(1);
  }
}

validateAddress(contractAddress, "CONTRACT_ADDRESS");
validateAddress(buyRouter, "BUY_ROUTER");
validateAddress(sellRouter, "SELL_ROUTER");
validateAddress(token, "TOKEN");

// --- Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(rpcUrl);
const wallet = new ethers.Wallet(PRIVATE_KEY.trim(), provider);

// --- Load ABI robustly ---
async function loadAbi(jsonPath) {
  const content = await fs.readFile(jsonPath, "utf8");
  const data = JSON.parse(content);

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.abi)) return data.abi;
  if (Array.isArray(data.contractAbi)) return data.contractAbi;

  throw new Error(`Unsupported ABI format in ${jsonPath}. Keys: ${Object.keys(data)}`);
}

// --- Main arbitrage function ---
async function main() {
  try {
    // Load ABI
    const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
    const abi = await loadAbi(abiPath);

    if (!Array.isArray(abi)) {
      console.error("ABI must be an array. Loaded type:", typeof abi);
      process.exit(1);
    }

    const arbContract = new ethers.Contract(contractAddress, abi, wallet);

    // Convert human-readable amount to smallest unit (6 decimals)
    if (!AMOUNT_IN_HUMAN) throw new Error("AMOUNT_IN_HUMAN not defined!");
    const amountIn = ethers.parseUnits(AMOUNT_IN_HUMAN.trim(), 6);
    console.log("Parsed AMOUNT_IN:", amountIn.toString());

    // --- Execute arbitrage ---
    console.log("🚀 Starting arbitrage...");
    console.log({ buyRouter, sellRouter, token, amountIn: amountIn.toString() });

    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountIn
    );

    console.log("Transaction sent! Hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("Transaction confirmed! Receipt:", receipt.transactionHash);

  } catch (err) {
    console.error("⚠️ Error executing arbitrage:", err);
    process.exit(1);
  }
}

// --- Run main ---
main().catch(err => {
  console.error("Unhandled error in arbitrage script:", err);
  process.exit(1);
});
