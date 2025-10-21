#!/usr/bin/env node
import * as ethers from "ethers";

// --- Environment variables ---
const {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN
} = process.env;

if (!RPC_URL || !PRIVATE_KEY || !BUY_ROUTER || !SELL_ROUTER || !TOKEN || !AMOUNT_IN_HUMAN) {
  console.error("Missing required environment variables!");
  process.exit(1);
}

// --- Constants ---
const MIN_PROFIT_USDC = 0.0000001; // minimum profit threshold
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// --- Trim and validate addresses ---
const buyRouter = BUY_ROUTER.trim();
const sellRouter = SELL_ROUTER.trim();
const token = TOKEN.trim();
const rpcUrl = RPC_URL.trim();

[buyRouter, sellRouter, token].forEach((addr) => {
  if (!ethers.isAddress(addr)) {
    console.error("Invalid Ethereum address:", addr);
    process.exit(1);
  }
});

// --- Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(rpcUrl);
const wallet = new ethers.Wallet(PRIVATE_KEY.trim(), provider);

// --- Contract ABI ---
const abi = [
  {
    "inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],
    "name":"executeArbitrage",
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
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

// --- Helpers ---
const parseAmount = (amountStr, decimals = 6) => ethers.parseUnits(amountStr, decimals);
const minProfitUnits = parseAmount(MIN_PROFIT_USDC.toString(), 6); // threshold in token smallest unit
const amountIn = parseAmount(AMOUNT_IN_HUMAN.trim(), 6);

console.log("🚀 Starting ARB bot with MIN_PROFIT_USDC =", MIN_PROFIT_USDC);

// --- Main loop ---
async function main() {
  while (true) {
    try {
      // --- Here we call executeArbitrage; assume contract calculates profit internally ---
      const tx = await arbContract.executeArbitrage(
        buyRouter,
        sellRouter,
        token,
        amountIn
      );

      console.log("Transaction sent. Hash:", tx.hash);
      const receipt = await tx.wait();
      console.log("Transaction confirmed. Receipt:", receipt.transactionHash);

      // --- Withdraw profits to wallet ---
      await arbContract.withdrawProfit(token);
      console.log("✅ Profit withdrawn");

      // --- Wait 5 seconds before next scan ---
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

