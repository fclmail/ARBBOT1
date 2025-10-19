// scripts/arbitrage.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Wallet, Contract, ethers } from 'ethers';

// Load ABI
const ABI = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'abi', 'AaveFlashArb.json'), 'utf8')
).abi;

// Load environment variables
const {
  RPC_URL,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN
} = process.env;

// Validate environment variables
if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS || !TOKEN) {
  console.error('❌ Missing required environment variables. Check your .env or GitHub Secrets.');
  process.exit(1);
}

// Connect wallet and contract
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);
const contract = new Contract(CONTRACT_ADDRESS, ABI, wallet);

// Helper: convert human-readable USDC.e to smallest units (6 decimals)
const decimals = 6;
const AMOUNT_IN = ethers.parseUnits(AMOUNT_IN_HUMAN || '0.01', decimals); // default 0.01 USDC.e

// Split comma-separated router lists
const buyRouters = BUY_ROUTER.split(',');
const sellRouters = SELL_ROUTER.split(',');

// Pick random buy/sell router
const RANDOM_BUY_ROUTER = buyRouters[Math.floor(Math.random() * buyRouters.length)];
const RANDOM_SELL_ROUTER = sellRouters[Math.floor(Math.random() * sellRouters.length)];

console.log('🚀 Starting arbitrage...');
console.log('Selected Buy Router:', RANDOM_BUY_ROUTER);
console.log('Selected Sell Router:', RANDOM_SELL_ROUTER);
console.log('Token:', TOKEN);
console.log('Amount (smallest units):', AMOUNT_IN.toString());

async function main() {
  try {
    const tx = await contract.executeArbitrage(
      RANDOM_BUY_ROUTER,
      RANDOM_SELL_ROUTER,
      TOKEN,
      AMOUNT_IN,
      { gasLimit: 1_500_000 }
    );

    console.log('✅ Transaction sent:', tx.hash);

    const receipt = await tx.wait();
    console.log('🎯 Transaction mined:', receipt.transactionHash);
    console.log('Status:', receipt.status);
  } catch (err) {
    console.error('⚠️ Error executing arbitrage:', err);
    process.exit(1);
  }
}

main();

