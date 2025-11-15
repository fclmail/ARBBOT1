
// ----------------------------------------------------
// AAVE FLASH ARB BOT - POLYGON
// Full arbitrage.js with hardcoded contract
// ----------------------------------------------------

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ----------------------------------------------------
// Provider + Wallet
// ----------------------------------------------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // HARDCODED

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ----------------------------------------------------
// Contract ABI
// ----------------------------------------------------
const arbAbi = [
  "function executeArbitrage(address buyDex, address sellDex, address token, uint256 amount) external",
  "function owner() external view returns(address)"
];

// ----------------------------------------------------
// Unified Contract Instance
// ----------------------------------------------------
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ----------------------------------------------------
// Utility: normalize addresses
// Prevents "bad address checksum"
// ----------------------------------------------------
const norm = (addr) => {
  try {
    return ethers.getAddress(addr);
  } catch {
    return null;
  }
};

// ----------------------------------------------------
// Execute Arbitrage
// Only changes: callStatic fix + checksum fix
// ----------------------------------------------------
async function executeTrade(buyRouter, sellRouter, token, amountUnits) {
  try {
    const buy = norm(buyRouter);
    const sell = norm(sellRouter);
    const tok = norm(token);

    if (!buy || !sell || !tok) {
      return { executed: false, reason: "Invalid checksum address" };
    }

    // --------------------------
    // 1️⃣ callStatic Simulation
    // --------------------------
    try {
      await arbContract.callStatic.executeArbitrage(buy, sell, tok, amountUnits);
    } catch (err) {
      return {
        executed: false,
        reason: "callStatic fail: " + (err.reason || err.message || "Simulation error")
      };
    }

    // --------------------------
    // 2️⃣ LIVE SEND
    // --------------------------
    const tx = await arbContract.executeArbitrage(buy, sell, tok, amountUnits, { gasLimit: 2_500_000 });
    const receipt = await tx.wait();

    return { executed: true, hash: receipt.transactionHash };
  } catch (err) {
    return { executed: false, reason: err.message };
  }
}

// ----------------------------------------------------
// EXPORTS
// ----------------------------------------------------
export { executeTrade, arbContract };

// ----------------------------------------------------
// ─────────────── MAIN LOOP 🟢11 ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    try {
      // Replace this with your scan() function
      console.log("🔍 Scanning for opportunities...");
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err) {
      console.error("⚠️ Scan error:", err);
    }
  }
}

main().catch(console.error);

