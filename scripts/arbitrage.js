// arb-dropin-esm-fixed.js
// Self-contained arbitrage bot drop-in for Ethers v6

import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ================= CONFIG =================
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

// PRIVATE_KEY must be 0x + 64 hex chars
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;
if (!PRIVATE_KEY || !PRIVATE_KEY_REGEX.test(PRIVATE_KEY)) {
  throw new Error("Invalid or missing PRIVATE_KEY. Expect 0x + 64 hex chars.");
}
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Vault contract and token addresses (adjust as needed)
const VAULT_CONTRACT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Inline ABIs
const VAULT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
  "function approveRouter(address router, uint256 amount) external"
];
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// ================= ROUTERS =================
// All addresses normalized to checksummed form
const ROUTERS = [
  "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff", // QuickSwap
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", // SushiSwap
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607", // ApeSwap
  "0xA102072A4C07F06EC3B4900FDC4C7B80b6C57429"  // Dfyn
].map(a => ethers.getAddress(a)); // checksummed

// ================= PATHS =================
const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  USDC: USDC_ADDRESS
};
const PATHS = {
  USDC_TO_WETH: [TOKENS.USDC, TOKENS.WETH],
  WETH_TO_USDC: [TOKENS.WETH, TOKENS.USDC]
};

// ================= CONTRACT INSTANCES =================
const vault = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, wallet);
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

// ================= HELPERS =================
async function safeApprove(token, spender, amount) {
  try {
    const allowance = await token.allowance(wallet.address, spender); // BigInt
    if (allowance < amount) {
      console.log(`[${new Date().toISOString()}] Approving ${ethers.formatUnits(amount, 6)} USDC for ${spender}`);
      const tx = await token.approve(spender, amount);
      await tx.wait();
      console.log(`[${new Date().toISOString()}] Approved ${spender}. Tx: ${tx.hash}`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Approval failed for ${spender}:`, err?.message || err);
  }
}

async function executeArbSafe(buyRouter, sellRouter, amountInUSDC) {
  try {
    const before = await usdc.balanceOf(wallet.address);

    const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      amountInUSDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );

    const receipt = await tx.wait();
    const after = await usdc.balanceOf(wallet.address);
    const profit = after - before;

    console.log(`[${new Date().toISOString()}] Arbitrage executed: Profit ${ethers.formatUnits(profit, 6)} USDC`);
    return true;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] 💤 Skipped ${buyRouter} -> ${sellRouter}:`, err?.message || err);
    return false;
  }
}

// ================= MAIN LOOP =================
async function main() {
  console.log("Starting arbitrage bot…");
  console.log(`✔ Wallet address: ${wallet.address}`);

  // Approve USDC for all routers (one-time)
  const amountToApprove = ethers.parseUnits("1000000", 6); // 1,000,000 USDC
  for (const router of ROUTERS) {
    await safeApprove(usdc, router, amountToApprove);
  }

  console.log("✅ Setup complete. Starting scan loop…");

  while (true) {
    for (const buy of ROUTERS) {
      for (const sell of ROUTERS) {
        if (buy.toLowerCase() === sell.toLowerCase()) continue;

        const amountInUSDC = ethers.parseUnits("10", 6); // 10 USDC per attempt
        await executeArbSafe(buy, sell, amountInUSDC);

        // Throttle to avoid spamming
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[${new Date().toISOString()}] Cycle complete. Restarting in 5s...`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ================= MAIN ENTRY =================
main().catch(err => {
  console.error("Fatal error in main:", err?.message || err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Received SIGINT. Exiting gracefully...");
  process.exit(0);
});
