#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { ethers } from 'ethers';

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
const provider = new ethers.providers.JsonRpcProvider(RPC_URL.trim());
const wallet = new ethers.Wallet(PRIVATE_KEY.trim(), provider);

// --- Load ABI robustly ---
async function loadAbi(jsonPath) {
const content = await fs.readFile(jsonPath, 'utf8');
const data = JSON.parse(content);

if (Array.isArray(data)) return data;
if (Array.isArray(data.abi)) return data.abi;
if (Array.isArray(data.contractAbi)) return data.contractAbi;

throw new Error(`Unsupported ABI format in ${jsonPath}. Keys: ${Object.keys(data)}`);
}

// --- Contract instance ---
async function main() {
// Resolve and load ABI
const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
const abi = await loadAbi(abiPath);

if (!Array.isArray(abi)) {
console.error("ABI must be an array. Loaded type:", typeof abi);
process.exit(1);
}

const contractAddress = CONTRACT_ADDRESS.trim();
const arbContract = new ethers.Contract(contractAddress, abi, wallet);

// --- Convert human-readable amount to smallest unit (assuming 6 decimals) ---
let amountIn;
try {
if (!AMOUNT_IN_HUMAN) throw new Error("AMOUNT_IN_HUMAN is not set in secrets!");
amountIn = ethers.utils.parseUnits(AMOUNT_IN_HUMAN.trim(), 6); // USDC-like decimals
console.log("Parsed AMOUNT_IN:", amountIn.toString());
} catch (err) {
console.error("Error parsing AMOUNT_IN_HUMAN:", err.message);
process.exit(1);
}

// --- Execute arbitrage ---
try {
console.log("🚀 Starting arbitrage...");
console.log({
BUY_ROUTER: BUY_ROUTER.trim(),
SELL_ROUTER: SELL_ROUTER.trim(),
TOKEN: TOKEN.trim(),
AMOUNT_IN: amountIn.toString()
});

const tx = await arbContract.executeArbitrage(
BUY_ROUTER.trim(),
SELL_ROUTER.trim(),
TOKEN.trim(),
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

main().catch((err) => {
console.error("Unhandled error in arbitrage script:", err);
process.exit(1);
});
