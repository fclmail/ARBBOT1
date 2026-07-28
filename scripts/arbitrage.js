import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ==========================================
// 1. SANITIZE & NORMALIZE INPUTS
// ==========================================
// Helper to strip whitespace/newlines and force lowercase before checksumming
const toSafeChecksumAddress = (rawAddress, fallbackAddress) => {
  const cleaned = rawAddress ? rawAddress.trim().replace(/[\r\n\t]/g, "").toLowerCase() : fallbackAddress.toLowerCase();
  return ethers.getAddress(cleaned);
};

const RPC_URL = (process.env.RPC_URL || "https://polygon-bor-rpc.publicnode.com").trim().replace(/[\r\n\t]/g, "");
const RAW_PK = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.trim().replace(/[\r\n\t]/g, "") : "";

if (!RAW_PK) {
  console.error("❌ Fatal Error: PRIVATE_KEY environment variable is missing!");
  process.exit(1);
}

// Convert inputs safely to EIP-55 Checksum Addresses
const PAIR_ADDRESS = toSafeChecksumAddress(process.env.PAIR_ADDRESS, "0x6F4acF77f837463641fd732DC167c9A383CB0d88");
const USDC_ADDRESS = toSafeChecksumAddress(process.env.USDC_ADDRESS, "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
// Polygon Mainnet QuickSwap V2 Router: 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff
const ROUTER_ADDRESS = toSafeChecksumAddress(process.env.ROUTER_ADDRESS, "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff");
