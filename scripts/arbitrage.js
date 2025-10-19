// scripts/arbitrage.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Wallet, Contract, ethers } from 'ethers';

const ABI = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'abi', 'AaveFlashArb.json'), 'utf8')
).abi;

const { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, BUY_ROUTER, SELL_ROUTER, TOKEN, AMOUNT_IN } =
  process.env;

if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error('❌ Missing environment variables. Check your .env or GitHub Secrets.');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);
const contract = new Contract(CONTRACT_ADDRESS, ABI, wallet);

async function main() {
  try {
    console.log('🚀 Starting arbitrage...');
    console.log({
      BUY_ROUTER,
      SELL_ROUTER,
      TOKEN,
      AMOUNT_IN,
    });

    const tx = await contract.executeArbitrage(BUY_ROUTER, SELL_ROUTER, TOKEN, AMOUNT_IN, {
      gasLimit: 1_500_000,
    });

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
