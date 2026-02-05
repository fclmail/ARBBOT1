import { ethers } from "ethers";
import VaultABI from "../abis/VaultArbitrageEnforcer.json";
import ERC20ABI from "../abis/IERC20.json";

// ------------------------- CONFIG -------------------------
const PROVIDER_URL = process.env.RPC || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC

// Routers - all checksummed
const ROUTERS = {
  quickswap: ethers.getAddress("0xa5E0829CaCED8fFDD4De3C43696c57F7D7A678ff"),
  sushi: ethers.getAddress("0xc0788a3aD43D79aa53B09C2eAcc313a787d1D607"),
  pangolin: ethers.getAddress("0xa102072a4C07F06ec3B4900FdC4c7B80b6C57429"),
};

// Minimum profit in USDC
const MIN_PROFIT = ethers.utils.parseUnits("0.000001", 6);

// ------------------------- PROVIDER & WALLET -------------------------
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("Starting arbitrage bot…");
console.log(`✔ Wallet address: ${wallet.address}`);
console.log(`Minimum profit enforced: ${ethers.formatUnits(MIN_PROFIT, 6)} USDC`);

// ------------------------- CONTRACTS -------------------------
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VaultABI, wallet);
const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20ABI, wallet);

// ------------------------- HELPERS -------------------------
async function approveToken(tokenAddress, spender, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20ABI, wallet);
  const allowance = await token.allowance(wallet.address, spender);

  if (allowance < amount) {
    console.log(`[${new Date().toISOString()}] Approving ${ethers.formatUnits(amount, 6)} USDC for router ${spender}`);
    const tx = await token.approve(spender, amount);
    await tx.wait();
    console.log(`[${new Date().toISOString()}] Router approved: ${spender} (Tx: ${tx.hash})`);
  } else {
    console.log(`[${new Date().toISOString()}] Router already approved: ${spender}`);
  }
}

// Safe fetch of contract method
function getContractOrNull(address, abi) {
  try {
    return new ethers.Contract(address, abi, wallet);
  } catch (err) {
    console.error(`Failed to create contract for ${address}:`, err.message);
    return null;
  }
}

// ------------------------- ARBITRAGE LOOP -------------------------
async function scanLoop() {
  const routerKeys = Object.keys(ROUTERS);

  for (let i = 0; i < routerKeys.length; i++) {
    for (let j = 0; j < routerKeys.length; j++) {
      if (i === j) continue;

      const buyRouter = ROUTERS[routerKeys[i]];
      const sellRouter = ROUTERS[routerKeys[j]];

      // Ensure vault contract is valid
      if (!vaultContract || !vaultContract.executeArbitrage) {
        console.log(`[${new Date().toISOString()}] Skipped ${buyRouter} -> ${sellRouter}: vault contract not loaded`);
        continue;
      }

      try {
        // Approve USDC for buy router
        await approveToken(USDC_ADDRESS, buyRouter, ethers.utils.parseUnits("100000", 6));

        // Example: call executeArbitrage (amount and paths need to be set for your tokens)
        // Using dummy paths; replace with actual token addresses
        const amountInUSDC = ethers.utils.parseUnits("10", 6); // 10 USDC
        const pathToToken = [USDC_ADDRESS, "0xTokenAddressHere"];
        const pathToUSDC = ["0xTokenAddressHere", USDC_ADDRESS];
        const deadline = Math.floor(Date.now() / 1000) + 60; // 1 min from now

        const tx = await vaultContract.executeArbitrage(
          buyRouter,
          sellRouter,
          amountInUSDC,
          pathToToken,
          pathToUSDC,
          deadline
        );

        console.log(`[${new Date().toISOString()}] Arbitrage executed: ${buyRouter} -> ${sellRouter} Tx: ${tx.hash}`);
      } catch (err) {
        console.log(`[${new Date().toISOString()}] 💤 Skipped ${buyRouter} -> ${sellRouter}: ${err.message}`);
      }
    }
  }

  console.log(`[${new Date().toISOString()}] Cycle complete. Restarting in 5s...`);
  setTimeout(scanLoop, 5000);
}

// ------------------------- START BOT -------------------------
async function main() {
  try {
    // Pre-approve all routers for USDC
    for (let key of Object.keys(ROUTERS)) {
      await approveToken(USDC_ADDRESS, ROUTERS[key], ethers.utils.parseUnits("100000", 6));
    }

    console.log("✅ Setup complete. Starting scan loop...");
    scanLoop();
  } catch (err) {
    console.error("Setup failed:", err);
  }
}

main();
