import { ethers } from "ethers";
import dotenv from "dotenv";
import VaultABI from "../abi/VaultArbitrage.json" assert { type: "json" };

dotenv.config();

/* ===================== CONFIG ===================== */

const RPC_URL = process.env.POLYGON_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT_ADDRESS = "0xYOUR_VAULT_ADDRESS";

// TOKEN ADDRESSES
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // polygon USDC

// ROUTER ADDRESSES (real routers, NOT enums)
const ROUTERS = {
  QUICKSWAP: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  SUSHISWAP: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  APESWAP: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

const MIN_PROFIT_USDC = 0.01;

/* ===================== SETUP ===================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  VaultABI,
  wallet
);

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
    `🚨 ${token} | Buy:${buyDex} → Sell:${sellDex} | Profit: ${profitUSDC}`
  );

  try {
    const buyRouter = ROUTERS[buyDex.toUpperCase()];
    const sellRouter = ROUTERS[sellDex.toUpperCase()];

    if (!buyRouter || !sellRouter) {
      throw new Error("Router not configured");
    }

    // REQUIRED BY CONTRACT
    const pathToToken = [USDC, tokenAddress];
    const pathToUSDC = [tokenAddress, USDC];

    const deadline = Math.floor(Date.now() / 1000) + 60;

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      amountIn,
      pathToToken,
      pathToUSDC,
      deadline,
      {
        gasLimit: 1_200_000,
      }
    );

    console.log("⏳ TX sent:", tx.hash);

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

/* ===================== MOCK SCANNER ===================== */

async function scanLoop() {
  console.log("🔍 Scanning for arbitrage opportunities...");

  await executeOpportunity({
    token: "CRV",
    tokenAddress: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
    buyDex: "APESWAP",
    sellDex: "SUSHISWAP",
    amountIn: ethers.parseUnits("500", 6), // USDC = 6 decimals
    profitUSDC: 0.5321,
  });
}

/* ===================== RUN ===================== */

setInterval(scanLoop, 15_000);
