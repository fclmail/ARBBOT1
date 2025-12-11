import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC = "https://polygon-rpc.com"; // <-- Your Polygon RPC URL
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not defined in .env");

const provider = new ethers.providers.JsonRpcProvider(RPC);
const wallet = new Wallet(WALLET_PRIVATE_KEY, provider);

// Vault contract (deployed) and ABI
const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const VAULT_ABI = [
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
    "inputs": [{ "internalType": "address", "name": "token", "type": "address" }],
    "name": "withdrawProfit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ---------------- TOKEN & DEX ADDRESSES ----------------
// Polygon Mainnet token addresses
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  CRV: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

// DEX routers
const DEXES = {
  QuickSwap: "0xa5e0829CaCED8FFDD4De3C43696c57F7D7A678ff",
  SushiSwap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ---------------- UTILITY FUNCTIONS ----------------
async function getVaultBalance(tokenAddress) {
  const tokenContract = new ethers.Contract(tokenAddress, [
    "function balanceOf(address owner) view returns (uint256)"
  ], provider);
  const balance = await tokenContract.balanceOf(VAULT_ADDRESS);
  return ethers.utils.formatUnits(balance, 6); // USDC has 6 decimals
}

// Execute arbitrage via vault contract
async function executeArbitrage(buyDex, sellDex, token, amountIn) {
  console.log(`Executing arbitrage: ${token} | Buy:${buyDex} Sell:${sellDex} | AmountIn: ${amountIn}`);
  const vaultBalanceBefore = await getVaultBalance(TOKENS.USDC);
  console.log(`🏦 Vault Balance Before: ${vaultBalanceBefore} USDC`);

  const tx = await vaultContract.executeArbitrage(DEXES[buyDex], DEXES[sellDex], TOKENS[token], ethers.utils.parseUnits(amountIn.toString(), 6));
  const receipt = await tx.wait();
  console.log(`🔁 TX SENT — ${receipt.transactionHash}`);

  const vaultBalanceAfter = await getVaultBalance(TOKENS.USDC);
  const profit = vaultBalanceAfter - vaultBalanceBefore;
  console.log(`💰 Vault Balance After: ${vaultBalanceAfter} USDC | Profit: ${profit.toFixed(6)} USDC`);
}

// Example arbitrage loop
async function main() {
  try {
    await executeArbitrage("QuickSwap", "SushiSwap", "AAVE", 10);
    await executeArbitrage("SushiSwap", "ApeSwap", "CRV", 5);
    await executeArbitrage("QuickSwap", "ApeSwap", "LINK", 50);
    await executeArbitrage("SushiSwap", "QuickSwap", "WBTC", 0.01);
  } catch (err) {
    console.error("Error executing arbitrage:", err);
  }
}

main();
