// arb-dropin-esm.js
// Drop-in arbitrage script with fixes for ES Module environments

// Import dependencies (ESM)
import { ethers } from "ethers";
import dotenv from "dotenv";

// Load env vars from .env if present (optional)
dotenv.config();

// ================= CONFIG =================
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

// PRIVATE_KEY: must be a 0x-prefixed 64-hex-character string
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

if (!PRIVATE_KEY || !PRIVATE_KEY_REGEX.test(PRIVATE_KEY)) {
  throw new Error(
    "Invalid or missing PRIVATE_KEY in environment variables. Expected: 0x + 64 hex chars."
  );
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ================= CONTRACT =================
const VAULT_CONTRACT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
  "function approveRouter(address router, uint256 amount) external"
];

// ================= ROUTERS =================
const ROUTERS = {
  quickswap: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

// ================= TOKENS =================
const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
};

// ================= PATHS =================
const PATHS = {
  USDC_TO_WETH: [TOKENS.USDC, TOKENS.WETH],
  WETH_TO_USDC: [TOKENS.WETH, TOKENS.USDC]
};

const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, wallet);

// ================= HELPERS =================
let lastAttemptTs = 0;
const COOLDOWN_MS = 1500; // 1.5 seconds between attempts
const CYCLE_DELAY_MS = 5000; // 5 seconds between full cycles

async function approveRouter(router, amount) {
  try {
    console.log(`[${new Date().toISOString()}] Approving ${amount.toString()} USDC for router ${router}`);
    const tx = await vaultContract.approveRouter(router, amount);
    const receipt = await tx.wait();
    console.log(`[${new Date().toISOString()}] Router approved: ${router} (Tx ${receipt.transactionHash})`);
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Approval failed for ${router}:`,
      err?.reason || err?.message || err
    );
  }
}

async function executeArb(buyRouter, sellRouter, amountInUSDC) {
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
  try {
    const tx = await vaultContract.executeArbitrage(
      buyRouter,
      sellRouter,
      amountInUSDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );
    console.log(
      `[${new Date().toISOString()}] Arbitrage tx sent: Buy ${buyRouter}, Sell ${sellRouter}, amountInUSDC=${amountInUSDC.toString()}`
    );
    const receipt = await tx.wait();
    console.log(`[${new Date().toISOString()}] Transaction confirmed. Hash: ${receipt.transactionHash}`);
    return true;
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Arbitrage execution failed:`,
      err?.reason || err?.message || err
    );
    return false;
  }
}

// ================= CONTINUOUS SCAN =================
async function scanAndExecute() {
  const amountUSDC = ethers.utils.parseUnits("1000", 6);
  const routerAddresses = Object.values(ROUTERS);

  while (true) {
    const now = Date.now();
    // Apply a simple per-attempt cooldown
    if (now - lastAttemptTs < COOLDOWN_MS) {
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    for (const buyRouter of routerAddresses) {
      for (const sellRouter of routerAddresses) {
        if (buyRouter === sellRouter) continue;

        const ok = await executeArb(buyRouter, sellRouter, amountUSDC);
        if (ok) {
          lastAttemptTs = Date.now();
        } else {
          lastAttemptTs = Date.now();
          // Optional: could break or continue; here we continue to try other pairs
        }

        // Small throttle between attempts
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[${new Date().toISOString()}] Cycle complete. Restarting scan in ${CYCLE_DELAY_MS / 1000}s...`);
    await new Promise(r => setTimeout(r, CYCLE_DELAY_MS));
  }
}

// ================= MAIN =================
async function main() {
  // Validate routers exist
  const routerAddresses = Object.values(ROUTERS);
  if (routerAddresses.length === 0) {
    throw new Error("No routers configured.");
  }

  // Pre-approve a sane amount per router
  const approveAmount = ethers.utils.parseUnits("1000000", 6); // 1,000,000 USDC
  for (const router of routerAddresses) {
    await approveRouter(router, approveAmount);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("Starting continuous arbitrage scan...");
  await scanAndExecute();
}

// Graceful shutdown
let shuttingDown = false;
process.on("SIGINT", () => {
  if (!shuttingDown) {
    shuttingDown = true;
    console.log("Received SIGINT. Exiting gracefully...");
    process.exit(0);
  }
});

main().catch(err => {
  console.error("Fatal error in main:", err?.message || err);
  process.exit(1);
});
