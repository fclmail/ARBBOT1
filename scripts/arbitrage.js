#!/usr/bin/env node
import * as ethers from "ethers";

// --- Load environment variables ---
const {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN
} = process.env;

// --- Validate environment ---
if (!RPC_URL || !PRIVATE_KEY || !BUY_ROUTER || !SELL_ROUTER || !TOKEN || !AMOUNT_IN_HUMAN) {
  console.error("Missing required environment variables!");
  process.exit(1);
}

// --- Trim and validate addresses ---
const buyRouter = BUY_ROUTER.trim();
const sellRouter = SELL_ROUTER.trim();
const token = TOKEN.trim();
const rpcUrl = RPC_URL.trim();

[buyRouter, sellRouter, token].forEach((addr, i) => {
  if (!ethers.isAddress(addr)) {
    console.error("Invalid Ethereum address:", addr);
    process.exit(1);
  }
});

// --- Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(rpcUrl);
const wallet = new ethers.Wallet(PRIVATE_KEY.trim(), provider);

// --- Contract ABI & Address ---
const contractAddress = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const abi = [
  {
    "inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],
    "name":"executeArbitrage",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "inputs":[{"internalType":"address","name":"asset","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"address","name":"","type":"address"},{"internalType":"bytes","name":"params","type":"bytes"}],
    "name":"executeOperation",
    "outputs":[{"internalType":"bool","name":"","type":"bool"}],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "inputs":[{"internalType":"uint256","name":"_minProfit","type":"uint256"}],
    "name":"setMinProfit",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "inputs":[{"internalType":"address","name":"token","type":"address"}],
    "name":"withdrawProfit",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  }
];

// --- Contract instance ---
const arbContract = new ethers.Contract(contractAddress, abi, wallet);

// --- Helper to parse human-readable amounts ---
const parseAmount = (amountStr, decimals = 6) => ethers.parseUnits(amountStr, decimals);

// --- Main arbitrage loop ---
async function main() {
  const amountIn = parseAmount(AMOUNT_IN_HUMAN.trim(), 6);

  console.log("🚀 Starting ARB bot...");
  console.log({ buyRouter, sellRouter, token, amountIn: amountIn.toString() });

  while (true) {
    try {
      // --- Get potential profit ---
      // For this ABI, the contract must compute internally; here we simulate raw profit via getAmountsOut if available
      // Since the contract does not have getAmountsOut, we'll just trigger executeArbitrage for demonstration
      // Replace this block with actual profit calculation using your own price feeds if needed

      // Execute arbitrage directly if profit threshold is met
      const tx = await arbContract.executeArbitrage(
        buyRouter,
        sellRouter,
        token,
        amountIn
      );

      console.log("Transaction sent. Hash:", tx.hash);
      const receipt = await tx.wait();
      console.log("Transaction confirmed. Receipt:", receipt.transactionHash);

      // Optional: withdraw profits back to wallet
      await arbContract.withdrawProfit(token);
      console.log("✅ Profit withdrawn.");

      // Wait a few seconds before next scan
      await new Promise(res => setTimeout(res, 5000));

    } catch (err) {
      console.error("⚠️ Error during arbitrage:", err);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
}

// --- Run ---
main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
