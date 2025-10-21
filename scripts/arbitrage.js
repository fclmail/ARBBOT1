#!/usr/bin/env node
import { JsonRpcProvider, Wallet, Contract, isAddress, parseUnits } from "ethers";

// --- Environment variables ---
const {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN
} = process.env;

// --- Basic validation ---
if (!RPC_URL || !PRIVATE_KEY || !BUY_ROUTER || !SELL_ROUTER || !TOKEN || !AMOUNT_IN_HUMAN) {
  console.error("❌ Missing required environment variables!");
  process.exit(1);
}

// --- Constants ---
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_PROFIT_USDC = 0.0000001; // minimum profit threshold (not yet used)

// --- Trim & validate addresses ---
const buyRouter = BUY_ROUTER.trim();
const sellRouter = SELL_ROUTER.trim();
const token = TOKEN.trim();
const rpcUrl = RPC_URL.trim();

for (const [name, addr] of [
  ["BUY_ROUTER", buyRouter],
  ["SELL_ROUTER", sellRouter],
  ["TOKEN", token],
  ["CONTRACT_ADDRESS", CONTRACT_ADDRESS]
]) {
  if (!isAddress(addr)) {
    console.error(`❌ Invalid Ethereum address for ${name}:`, addr);
    process.exit(1);
  }
}

// --- Provider & Wallet ---
const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

// --- Contract ABI ---
const abi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "token", "type": "address" }
    ],
    "name": "withdrawProfit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// --- Contract instance ---
const arbContract = new Contract(CONTRACT_ADDRESS, abi, wallet);

// --- Helpers ---
const parseAmount = (amountStr, decimals = 6) => parseUnits(amountStr, decimals);
const amountIn = parseAmount(AMOUNT_IN_HUMAN.trim(), 6);

console.log("🚀 ARB bot starting...");
console.log("💰 Using amount:", AMOUNT_IN_HUMAN);
console.log("📡 RPC:", rpcUrl);
console.log("Routers:", { buyRouter, sellRouter });

// --- Main loop ---
async function main() {
  while (true) {
    try {
      const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, token, amountIn);
      console.log("📤 Transaction sent:", tx.hash);

      const receipt = await tx.wait();
      console.log("✅ Confirmed:", receipt.transactionHash);

      const withdrawTx = await arbContract.withdrawProfit(token);
      console.log("💸 Withdrawing profit:", withdrawTx.hash);
      await withdrawTx.wait();
      console.log("✅ Profit withdrawn");

      // Wait before next cycle
      await new Promise((res) => setTimeout(res, 5000));
    } catch (err) {
      console.error("⚠️ Error during arbitrage:", err.message || err);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

// --- Run ---
main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
