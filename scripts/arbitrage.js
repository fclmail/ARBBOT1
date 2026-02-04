// arb-dropin-esm-fixed.js
// Drop-in arbitrage bot (ethers v6, ES Modules, VaultArbitrageEnforcer compatible)

// ================= IMPORTS =================
import { ethers } from "ethers";
import dotenv from "dotenv";

// ================= ENV =================
dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

// PRIVATE_KEY must be 0x + 64 hex chars
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

if (!PRIVATE_KEY || !PRIVATE_KEY_REGEX.test(PRIVATE_KEY)) {
  throw new Error(
    "Invalid or missing PRIVATE_KEY. Expected: 0x + 64 hex chars."
  );
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ================= CONTRACT =================
const VAULT_CONTRACT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
  "function approveRouter(address router, uint256 amount) external",
  "function routerAllowance(address router) view returns (uint256)",
  "function setMinimumProfitUSDC(uint256 _min) external"
];

const vaultContract = new ethers.Contract(
  VAULT_CONTRACT_ADDRESS,
  VAULT_ABI,
  wallet
);

// ================= ROUTERS =================
const ROUTERS = {
  quickswap: "0xa5e0829caCED8FFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607",
  dfyn: "0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429"
};

// ================= TOKENS & PATHS =================
const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
};

const PATHS = {
  USDC_TO_WETH: [TOKENS.USDC, TOKENS.WETH],
  WETH_TO_USDC: [TOKENS.WETH, TOKENS.USDC]
};

// ================= HELPERS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastAttemptTs = 0;
const COOLDOWN_MS = 1500; // 1.5s between attempts
const CYCLE_DELAY_MS = 5000; // 5s between full cycles

// ================= ARBITRAGE ACTIONS =================
async function approveRouter(router, amount) {
  try {
    console.log(`[${new Date().toISOString()}] Approving ${amount.toString()} USDC for router ${router}`);
    const tx = await vaultContract.approveRouter(router, amount);
    const receipt = await tx.wait();
    console.log(`[${new Date().toISOString()}] Router approved: ${router} (Tx: ${receipt.transactionHash})`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Approval failed for ${router}:`, err?.reason || err?.message || err);
  }
}

async function executeArb(buyRouter, sellRouter, amountUSDC) {
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min
  try {
    // ✅ ethers v6 simulation before sending actual tx
    await vaultContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      amountUSDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );

    const tx = await vaultContract.executeArbitrage(
      buyRouter,
      sellRouter,
      amountUSDC,
      PATHS.USDC_TO_WETH,
      PATHS.WETH_TO_USDC,
      deadline
    );

    console.log(`[${new Date().toISOString()}] 🚀 Arbitrage tx sent: Buy ${buyRouter}, Sell ${sellRouter}, amount=${amountUSDC.toString()}`);
    const receipt = await tx.wait();
    console.log(`[${new Date().toISOString()}] ✅ Arbitrage confirmed (Tx: ${receipt.transactionHash})`);
    return true;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] 💤 Skipped ${buyRouter} -> ${sellRouter}:`, err?.reason || err?.message || err);
    return false;
  }
}

// ================= SCANNER LOOP =================
async function scanLoop() {
  const routerAddresses = Object.values(ROUTERS);
  const amountUSDC = ethers.parseUnits("1000", 6); // 1000 USDC

  while (true) {
    const now = Date.now();
    if (now - lastAttemptTs < COOLDOWN_MS) {
      await sleep(200);
      continue;
    }

    for (const buy of routerAddresses) {
      for (const sell of routerAddresses) {
        if (buy === sell) continue;

        await executeArb(buy, sell, amountUSDC);
        lastAttemptTs = Date.now();
        await sleep(500);
      }
    }

    console.log(`[${new Date().toISOString()}] Cycle complete. Restarting in ${CYCLE_DELAY_MS/1000}s...`);
    await sleep(CYCLE_DELAY_MS);
  }
}

// ================= MAIN =================
async function main() {
  console.log("Starting arbitrage bot...");

  // Optional: check if wallet is vault owner
  const walletAddress = await wallet.getAddress();
  console.log(`✔ Wallet address: ${walletAddress}`);

  // Set minimum profit (1 USDC = 10^6 units)
  const minProfit = ethers.parseUnits("0.000001", 6);
  try {
    await vaultContract.setMinimumProfitUSDC(minProfit);
    console.log(`Minimum profit enforced: ${ethers.formatUnits(minProfit, 6)} USDC`);
  } catch (err) {
    console.error("Failed to set minimum profit:", err?.message || err);
  }

  // Approve routers
  const approveAmount = ethers.parseUnits("1000000", 6); // 1,000,000 USDC
  for (const router of Object.values(ROUTERS)) {
    await approveRouter(router, approveAmount);
    await sleep(500);
  }

  console.log("✅ Setup complete. Starting scan loop...");
  await scanLoop();
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

// ================= BOOT =================
main().catch(err => {
  console.error("Fatal error:", err?.message || err);
  process.exit(1);
});
