// arbitrageBot.js
import { ethers } from "ethers";

// ===== CONFIG ===== //
const RPC_URL = "https://mainnet.infura.io/v3/YOUR_INFURA_KEY"; // Replace with your RPC
const PRIVATE_KEY = "YOUR_PRIVATE_KEY"; // Wallet holding USDC
const CONTRACT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

// Minimum profit: 0.000001 USDC (USDC has 6 decimals)
const MIN_PROFIT_USDC = 1; // 1 = 0.000001 USDC

// Contract ABI (only needed functions)
const CONTRACT_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,uint256 amountInUSDC,address[] calldata pathToToken,address[] calldata pathToUSDC,uint256 deadline) external",
  "function setMinimumProfitUSDC(uint256 _min) external",
  "function usdc() view returns(address)",
  "function balanceOf(address account) view returns(uint256)",
  "function approve(address spender, uint256 amount) external returns(bool)"
];

// Routers for arbitrage
const BUY_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const SELL_ROUTER = "0xa5E0829CAecd8FfDD4de3C43696c57F7D7A678Ff";

// Example token paths (USDC -> TOKEN -> USDC)
const PATH_TO_TOKEN = [
  "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2"  // WETH example
];

const PATH_TO_USDC = [
  "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"  // USDC
];

// Amount to swap in USDC (6 decimals)
const AMOUNT_IN_USDC = ethers.BigNumber.from("1000000"); // 1 USDC

// ===== SETUP PROVIDER & CONTRACT ===== //
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

async function main() {
  console.log("✅ Setting minimum profit to 0.000001 USDC...");
  const txSetMin = await contract.setMinimumProfitUSDC(MIN_PROFIT_USDC);
  await txSetMin.wait();
  console.log("✅ Minimum profit set.");

  console.log("⌛ Starting arbitrage loop...");

  while (true) {
    try {
      // Get USDC contract address
      const usdcAddress = await contract.usdc();
      const usdcContract = new ethers.Contract(
        usdcAddress,
        ["function balanceOf(address) view returns(uint256)",
         "function approve(address,uint256) returns(bool)",
         "function allowance(address,address) view returns(uint256)"],
        wallet
      );

      // Check USDC balance
      const balance = await usdcContract.balanceOf(wallet.address);
      if (balance.lt(AMOUNT_IN_USDC)) {
        console.log("⚠️ Insufficient USDC balance for arbitrage. Skipping...");
        await delay(5000);
        continue;
      }

      // Approve buy router if needed
      const allowance = await usdcContract.allowance(wallet.address, BUY_ROUTER);
      if (allowance.lt(AMOUNT_IN_USDC)) {
        const approveTx = await usdcContract.approve(BUY_ROUTER, AMOUNT_IN_USDC);
        await approveTx.wait();
        console.log("✅ Approved buy router for USDC.");
      }

      const deadline = Math.floor(Date.now() / 1000) + 60; // 1 min deadline

      // Estimate gas for executeArbitrage
      const gasEstimate = await contract.estimateGas.executeArbitrage(
        BUY_ROUTER,
        SELL_ROUTER,
        AMOUNT_IN_USDC,
        PATH_TO_TOKEN,
        PATH_TO_USDC,
        deadline
      );

      // Execute arbitrage immediately
      const tx = await contract.executeArbitrage(
        BUY_ROUTER,
        SELL_ROUTER,
        AMOUNT_IN_USDC,
        PATH_TO_TOKEN,
        PATH_TO_USDC,
        deadline,
        {
          gasLimit: gasEstimate.mul(110).div(100) // +10% buffer
        }
      );
      const receipt = await tx.wait();
      console.log("✅ Arbitrage executed! Tx hash:", receipt.transactionHash);

    } catch (err) {
      if (err.reason && err.reason.includes("Profit below minimum threshold")) {
        console.log("💤 Profit below threshold. Skipping this round...");
      } else {
        console.error("❌ Error executing arbitrage:", err);
      }
    }

    await delay(5000); // 5 seconds between cycles
  }
}

// Simple delay helper
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
