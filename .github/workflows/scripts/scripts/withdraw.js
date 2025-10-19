// scripts/withdraw.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Wallet, Contract, ethers } from 'ethers';

const ABI = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'abi', 'AaveFlashArb.json'), 'utf8')
).abi;

const { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, TOKEN } = process.env;

if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS || !TOKEN) {
  console.error('❌ Missing environment variables. Check your .env or GitHub Secrets.');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);
const contract = new Contract(CONTRACT_ADDRESS, ABI, wallet);

async function main() {
  try {
    console.log('💰 Withdrawing profits for token:', TOKEN);

    const tx = await contract.withdrawProfit(TOKEN, {
      gasLimit: 200_000,
    });

    console.log('✅ Transaction sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('🎯 Transaction mined:', receipt.transactionHash);
    console.log('Status:', receipt.status);
  } catch (err) {
    console.error('⚠️ Error withdrawing profit:', err);
    process.exit(1);
  }
}

main();
