import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/* ================= ENV ================= */

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= FIXED USDC ================= */

const USDC = ethers.getAddress(
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa841740"
);

/* ================= ROUTERS ================= */

const ROUTERS = {
  QuickSwap: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
  SushiSwap: ethers.getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"),
  ApeSwap: ethers.getAddress("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"),
  Dfyn: ethers.getAddress("0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429")
};

/* ================= FULL CORRECT ABI ================= */

const CONTRACT_ABI = [
  {
    "inputs": [],
    "name": "POOL",
    "outputs": [{ "internalType": "contract IPool", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "vault",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "minimumProfitUSDC",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "uint256", "name": "amountInUSDC", "type": "uint256" },
      { "internalType": "address[]", "name": "pathToToken", "type": "address[]" },
      { "internalType": "address[]", "name": "pathToUSDC", "type": "address[]" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "uint256", "name": "amountInUSDC", "type": "uint256" },
      { "internalType": "address[]", "name": "pathToToken", "type": "address[]" },
      { "internalType": "address[]", "name": "pathToUSDC", "type": "address[]" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" }
    ],
    "name": "executeFlashArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "amount", "type": "uint256" }],
    "name": "withdraw",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

/* ================= CONTRACT ================= */

const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  wallet
);

/* ================= HELPER ================= */

function normalize(address) {
  return ethers.getAddress(address);
}

/* ================= EXECUTE TRADE ================= */

async function executeTrade(
  buyRouter,
  sellRouter,
  amountInUSDC,
  token
) {
  try {
    const deadline = Math.floor(Date.now() / 1000) + 60;

    const pathToToken = [
      normalize(USDC),
      normalize(token)
    ];

    const pathToUSDC = [
      normalize(token),
      normalize(USDC)
    ];

    const tx = await contract.executeFlashArbitrage(
      normalize(buyRouter),
      normalize(sellRouter),
      amountInUSDC,
      pathToToken,
      pathToUSDC,
      deadline
    );

    console.log("🚀 Flash tx sent:", tx.hash);
    await tx.wait();
    console.log("✅ Flash arbitrage executed");

  } catch (err) {
    console.log("⚠️ Trade failed:", err.reason || err.message);
  }
}

/* ================= START BOT ================= */

async function start() {
  console.log("PRIVATE_KEY:", PRIVATE_KEY ? "[OK]" : "[MISSING]");
  console.log("CONTRACT_ADDRESS:", CONTRACT_ADDRESS ? "[OK]" : "[MISSING]");
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  console.log("🔍 Scanning for arbitrage opportunities...");
}

start();
