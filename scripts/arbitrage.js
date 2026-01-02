// scripts/arbitrage.js
import { ethers } from "ethers";

/* =====================================================
   CONFIGURATION (HARDCODED WHERE REQUESTED)
===================================================== */

// ✅ HARDCODED POLYGON RPC (FIXES YOUR ERROR)
const RPC_URL = "https://polygon-rpc.com";

// ✅ PRIVATE KEY FROM GITHUB SECRETS
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ✅ HARDCODED ARBITRAGE CONTRACT ADDRESS
const CONTRACT_ADDRESS = "0xYourContractAddressHere"; // <-- PUT REAL ADDRESS

// BOT SETTINGS
const DRY_RUN = true;          // true = no tx sent
const SCAN_INTERVAL_MS = 5000; // 5 seconds

/* =====================================================
   CONTRACT ABI (MUST MATCH DEPLOYED CONTRACT)
===================================================== */
const CONTRACT_ABI = [
  "function executeArbitrage(uint256 amount) external",
  "function getVaultBalance(address token) external view returns (uint256)"
];

/* =====================================================
   VALIDATION
===================================================== */
if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY not set in secrets");
  process.exit(1);
}

/* =====================================================
   PROVIDER & WALLET
===================================================== */
const provider = new ethers.JsonRpcProvider(RPC_URL);

let wallet;
try {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("✅ Wallet loaded:", wallet.address);
} catch (err) {
  console.error("❌ Wallet init failed:", err.message);
  process.exit(1);
}

/* =====================================================
   CONTRACT INIT (SAFE)
===================================================== */
let arbContract;
try {
  arbContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

  if (typeof arbContract.executeArbitrage !== "function") {
    throw new Error("executeArbitrage not found in ABI");
  }

  console.log("✅ Arbitrage contract initialized:", CONTRACT_ADDRESS);
} catch (err) {
  console.error("❌ Contract init failed:", err.message);
  process.exit(1);
}

/* =====================================================
   HELPERS
===================================================== */

// Vault USDC balance
async function getVaultBalance() {
  try {
    const bal = await arbContract.getVaultBalance(
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" // USDC Polygon
    );
    return Number(ethers.formatUnits(bal, 6));
  } catch {
    return 0;
  }
}

// Wallet MATIC balance
async function getWalletMatic() {
  const bal = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}

// 🔁 PLACEHOLDER ARB LOGIC (YOUR EXISTING LOGIC GOES HERE)
function calculateArbitrage(amount) {
  const expectedProfit = -0.007851; // matches your logs
  return {
    buyTokens: 243028771375281820n,
    sellUSDC: 0.092149,
    expectedProfit
  };
}

/* =====================================================
   ARBITRAGE EXECUTION
===================================================== */
async function attemptArbitrage() {
  console.log(`🏦 Vault USDC: ${await getVaultBalance()}`);
  console.log(`🏦 Wallet MATIC balance: ${await getWalletMatic()}`);

  const amount = 0.1;
  const { buyTokens, sellUSDC, expectedProfit } =
    calculateArbitrage(amount);

  console.log("🔍 Attempting arbitrage...");
  console.log(`💰 Expected buy: ${amount} USDC -> ${buyTokens}`);
  console.log(`💵 Expected sell: ${buyTokens} -> ${sellUSDC} USDC`);
  console.log(`💸 Expected profit: ${expectedProfit} USDC`);

  if (expectedProfit <= 0) {
    console.log("❌ Skipping trade: not profitable");
    return;
  }

  if (DRY_RUN) {
    console.log("⚠️ Dry-run: transaction not sent");
    return;
  }

  try {
    const tx = await arbContract.executeArbitrage(
      ethers.parseUnits(amount.toString(), 6)
    );
    console.log("🚀 Tx sent:", tx.hash);
    await tx.wait();
    console.log("✅ Arbitrage executed");
  } catch (err) {
    console.error("❌ Tx failed:", err.message);
  }
}

/* =====================================================
   MAIN LOOP
===================================================== */
async function main() {
  console.log("⏱ Polygon Arb Bot Started");

  while (true) {
    try {
      await attemptArbitrage();
    } catch (err) {
      console.error("❌ Loop error:", err.message);
    }

    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
