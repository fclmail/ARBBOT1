import { ethers } from "ethers";

// --- Provider & Wallet ---
const RPC_URL = "https://polygon-rpc.com"; // Or your Infura Polygon URL
const PRIVATE_KEY = "0xYOUR_PRIVATE_KEY";  // Replace with your wallet private key
const CONTRACT_ADDRESS = "0xYOUR_CONTRACT_ADDRESS"; // Replace with deployed contract address

// --- Routers ---
const BUY_ROUTERS = [
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
];
const SELL_ROUTERS = [
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
];

// --- Token and amount ---
const TOKEN = "0xUSDCeTokenAddress"; // Replace with USDC.e token on Polygon
const AMOUNT_IN = ethers.parseUnits("0.0001", 6); // 0.0001 USDC.e, 6 decimals

// --- Contract ABI ---
// Paste your full ABI array here
const abi = [
  // Example ABI snippet for reference:
  // {
  //   "inputs": [
  //     { "internalType": "address", "name": "buyRouter", "type": "address" },
  //     { "internalType": "address", "name": "sellRouter", "type": "address" },
  //     { "internalType": "address", "name": "token", "type": "address" },
  //     { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
  //   ],
  //   "name": "executeArbitrage",
  //   "outputs": [],
  //   "stateMutability": "nonpayable",
  //   "type": "function"
  // }
];

// --- Contract instance ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

// --- Main execution ---
async function main() {
  for (const buy of BUY_ROUTERS) {
    for (const sell of SELL_ROUTERS) {
      try {
        console.log(`Executing arbitrage: Buy ${buy} -> Sell ${sell}`);
        const tx = await contract.executeArbitrage(buy, sell, TOKEN, AMOUNT_IN);
        console.log("Transaction sent:", tx.hash);
        const receipt = await tx.wait();
        console.log("Transaction confirmed:", receipt.transactionHash);
      } catch (err) {
        console.error("Error executing arbitrage:", err);
      }
    }
  }
}

// --- Run ---
main();
