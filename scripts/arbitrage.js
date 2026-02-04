import { ethers } from "ethers";
import dotenv from "dotenv";
import VaultABI from "../abi/VaultArbitrage.json" assert { type: "json" };

dotenv.config();

/* ===================== CONFIG ===================== */

const RPC_URL = process.env.POLYGON_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// VAULT = ARBITRAGE CONTRACT
const VAULT_ADDRESS = "0xYOUR_VAULT_ADDRESS";

// token decimals assumed handled in scanner
const MIN_PROFIT_USDC = 0.01;

// DEX IDs MUST MATCH SOLIDITY ENUM
const DEX = {
  QUICKSWAP: 0,
  SUSHISWAP: 1,
  APESWAP: 2,
};

/* ===================== SETUP ===================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// vault == arbitrage executor
const vault = new ethers.Contract(
  VAULT_ADDRESS,
  VaultABI,
  wallet
);

// HARD FAIL EARLY IF MISWIRED
if (!vault.executeArbitrage) {
  throw new Error("❌ executeArbitrage not found in Vault ABI");
}

console.log("✅ Vault contract loaded:", vault.target);

/* ===================== CORE EXECUTION ===================== */

async function executeOpportunity(op) {
  const {
    token,
    tokenAddress,
    buyDex,
    sellDex,
    amountIn,
    profitUSDC,
  } = op;

  if (profitUSDC < MIN_PROFIT_USDC) return;

  console.log(
    `🚨 ${token} | Buy:${buyDex} → Sell:${sellDex} | Profit: ${profitUSDC} USDC`
  );

  try {
    const tx = await vault.executeArbitrage(
      tokenAddress,
      DEX[buyDex.toUpperCase()],
      DEX[sellDex.toUpperCase()],
      amountIn,
      {
        gasLimit: 1_200_000,
      }
    );

    console.log(`⏳ TX sent: ${tx.hash}`);

    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      throw new Error("Transaction reverted");
    }

    console.log(
      `✅ Arbitrage executed | Gas used: ${receipt.gasUsed.toString()}`
    );
  } catch (err) {
    console.error("⚠️ Trade failed:", err.reason || err.message);
  }
}

/* ===================== MOCK SCANNER HOOK ===================== */
/* Replace this with your real scanner output */

async function scanLoop() {
  console.log("🔍 Scanning for arbitrage opportunities...");

  // example opportunity (matches your logs)
  await executeOpportunity({
    token: "CRV",
    tokenAddress: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
    buyDex: "ApeSwap",
    sellDex: "SushiSwap",
    amountIn: ethers.parseUnits("500", 18),
    profitUSDC: 0.5321,
  });
}

/* ===================== RUN ===================== */

setInterval(scanLoop, 15_000);
