import { ethers } from "ethers";
import "dotenv/config";

// ================= CONFIG =================
const RPC_URL = process.env.RPC_URL; // Polygon RPC
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Wallet private key
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73" // optional, might be invalid
};

const MIN_PROFIT_USDC = ethers.parseUnits("1", 6); // minimum 1 USDC profit

// ================= ABI INLINED =================
const AAVE_FLASH_ARB_ABI = [
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
      { "internalType": "address", "name": "asset", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "internalType": "uint256", "name": "premium", "type": "uint256" },
      { "internalType": "address", "name": "", "type": "address" },
      { "internalType": "bytes", "name": "params", "type": "bytes" }
    ],
    "name": "executeOperation",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "_minProfit", "type": "uint256" }],
    "name": "setMinProfit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "_aavePool", "type": "address" },
      { "internalType": "address", "name": "_usdc", "type": "address" },
      { "internalType": "uint256", "name": "_minProfit", "type": "uint256" }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [{ "internalType": "address", "name": "token", "type": "address" }],
    "name": "withdrawProfit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "AAVE_POOL", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

// ================= PROVIDER & WALLET =================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, AAVE_FLASH_ARB_ABI, wallet);

// ================= ARBITRAGE FUNCTION =================
async function runArbitrage(buyRouter, sellRouter, token, amountIn) {
  try {
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, token, amountIn, {
      gasLimit: 5_000_000
    });
    console.log(`Arbitrage tx sent: ${tx.hash}`);
    await tx.wait();
    console.log("Arbitrage executed successfully!");
  } catch (err) {
    console.error("Trade failed or reverted:", err.reason || err);
  }
}

// ================= MOCK SCAN & EXECUTE =================
async function scanAndExecute() {
  console.log("🚀 Starting arbitrage scan...");

  // Example tokens & amounts
  const tokenList = [
    "0x172370d5Cd63279eFa6d502DAB29171933a610AF", // CRV
    "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39"  // LINK
  ];
  const amountIn = ethers.parseUnits("100", 6); // 100 USDC

  for (const token of tokenList) {
    // QuickSwap → ApeSwap
    if (ROUTERS.QuickSwap && ROUTERS.ApeSwap) {
      console.log(`Scanning opportunity: QuickSwap -> ApeSwap for ${token}`);
      await runArbitrage(ROUTERS.QuickSwap, ROUTERS.ApeSwap, token, amountIn);
    }

    // SushiSwap → ApeSwap
    if (ROUTERS.SushiSwap && ROUTERS.ApeSwap) {
      console.log(`Scanning opportunity: SushiSwap -> ApeSwap for ${token}`);
      await runArbitrage(ROUTERS.SushiSwap, ROUTERS.ApeSwap, token, amountIn);
    }
  }
}

// ================= MAIN =================
(async () => {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  await scanAndExecute();
})();

