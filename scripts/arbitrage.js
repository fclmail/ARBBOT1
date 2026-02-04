import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

/* =========================================================
   INLINE ABI (no filesystem / json import issues anymore)
   ========================================================= */

const VaultABI = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "uint256", name: "amountInUSDC", type: "uint256" },
      { internalType: "address[]", name: "pathToToken", type: "address[]" },
      { internalType: "address[]", name: "pathToUSDC", type: "address[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
];

/* ===================== CONFIG ===================== */

const RPC_URL = process.env.POLYGON_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT_ADDRESS = "0xYOUR_VAULT_ADDRESS";

// Polygon USDC
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// REAL ROUTERS (addresses, NOT enums)
const ROUTERS = {
  QUICKSWAP: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  SUSHISWAP: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  APESWAP: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
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

console.log("✅ Vault loaded:", vault.target);

/* ===================== EXECUTION ===================== */

async function executeOpportunity(op) {
  const {
    token,
    tokenAddress,
    buyDex,
    sellDex,
    amountIn,
    profitUSDC
  } = op;

  if (profitUSDC < MIN_PROFIT_USDC) return;

  console.log(
    `🚨 ${token} | ${buyDex} → ${sellDex} | profit: ${profitUSDC} USDC`
  );

  try {
    const buyRouter = ROUTERS[buyDex.toUpperCase()];
    const sellRouter = ROUTERS[sellDex.toUpperCase()];

    if (!buyRouter || !sellRouter) {
      throw new Error("Router not configured");
    }

    // REQUIRED by Solidity
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
      { gasLimit: 1_200_000 }
    );

    console.log("⏳ TX sent:", tx.hash);

    const receipt = await tx.wait();

    console.log(
      `✅ Success | gasUsed: ${receipt.gasUsed.toString()}`
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

    // USDC has 6 decimals
    amountIn: ethers.parseUnits("500", 6),

    profitUSDC: 0.53
  });
}

/* ===================== RUN ===================== */

scanLoop(); // run once immediately
setInterval(scanLoop, 15_000);
