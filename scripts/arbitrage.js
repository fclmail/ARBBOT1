// arbitrage.js
import { ethers } from 'ethers';

// Environment variables
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BUY_ROUTER = process.env.BUY_ROUTER;
const SELL_ROUTER = process.env.SELL_ROUTER;
const TOKEN = process.env.TOKEN;
const AMOUNT_IN_HUMAN = process.env.AMOUNT_IN_HUMAN;
const USDC_ADDRESS = process.env.USDC_ADDRESS;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const MIN_PROFIT_USDC = ethers.parseUnits("0.000001", 6); // 1 = 0.000001 USDC

// Provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Contract ABI and address
const contractABI = [
  {
    "inputs": [],
    "name": "POOL",
    "outputs": [{ "internalType": "contract IPool", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "asset", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "internalType": "uint256", "name": "premium", "type": "uint256" },
      { "internalType": "address", "name": "initiator", "type": "address" },
      { "internalType": "bytes", "name": "params", "type": "bytes" }
    ],
    "name": "executeOperation",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

const contractAddress = '0xAB046582A36D00f4921C447db9b77644b5e43c95';
const contract = new ethers.Contract(contractAddress, contractABI, wallet);

// Helper: Fetch AAVE liquidity (example placeholder)
async function fetchLiquidity() {
  try {
    const liquidity = await contract.POOL();
    console.log(`🏦 AAVE USDC Liquidity: ${ethers.formatUnits(liquidity, 18)}`);
  } catch (err) {
    console.error('Error fetching liquidity:', err);
  }
}

// Helper: Fetch vault balance
async function fetchVaultBalance() {
  try {
    const vault = new ethers.Contract(VAULT_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
    const balance = await vault.balanceOf(VAULT_ADDRESS);
    console.log(`🔹 Vault Balance: ${ethers.formatUnits(balance, 6)} USDC`);
  } catch (err) {
    console.error('Error fetching vault balance:', err);
  }
}

// Main arbitrage execution
async function executeArbitrage() {
  try {
    console.log('🚀 Arbitrage bot started');

    await fetchLiquidity();
    await fetchVaultBalance();

    const amountInUSDC = ethers.parseUnits(AMOUNT_IN_HUMAN, 6);

    const tx = await contract.executeArbitrage(
      BUY_ROUTER,
      SELL_ROUTER,
      amountInUSDC,
      [TOKEN],       // path to token
      [USDC_ADDRESS], // path back to USDC
      Math.floor(Date.now() / 1000) + 60 * 10 // 10 min deadline
    );

    await tx.wait();
    console.log(`Transaction successful: ${tx.hash}`);

    await fetchLiquidity();
    await fetchVaultBalance();
  } catch (err) {
    console.error('Arbitrage failed:', err);
  }
}

executeArbitrage();
