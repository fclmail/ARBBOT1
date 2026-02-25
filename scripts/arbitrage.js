import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/* ================= SAFE ADDRESS HELPER ================= */

function safeAddress(value, label) {
  try {
    if (!value || value === "0") {
      throw new Error("Empty");
    }
    return ethers.getAddress(value.trim());
  } catch {
    console.log(`⚠️ Invalid ${label}:`, value);
    return null;
  }
}

/* ================= ENV ================= */

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const CONTRACT_ADDRESS = safeAddress(
  process.env.CONTRACT_ADDRESS || "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E",
  "CONTRACT_ADDRESS"
);

const BUY_ROUTER = safeAddress(process.env.BUY_ROUTER, "BUY_ROUTER");
const SELL_ROUTER = safeAddress(process.env.SELL_ROUTER, "SELL_ROUTER");
const TOKEN = safeAddress(process.env.TOKEN, "TOKEN");
const USDC = safeAddress(
  process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "USDC"
);

const AMOUNT_IN = process.env.AMOUNT_IN_HUMAN || "0";

/* ================= PROVIDER ================= */

if (!RPC_URL || !PRIVATE_KEY) {
  console.log("❌ Missing RPC_URL or PRIVATE_KEY");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ABI ================= */

const CONTRACT_ABI = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "uint256", name: "amountInUSDC", type: "uint256" },
      { internalType: "address[]", name: "pathToToken", type: "address[]" },
      { internalType: "address[]", name: "pathToUSDC", type: "address[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" }
    ],
    name: "executeFlashArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  }
];

/* ================= CONTRACT ================= */

if (!CONTRACT_ADDRESS) {
  console.log("❌ Contract address invalid");
  process.exit(1);
}

const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  wallet
);

/* ================= EXECUTION ================= */

async function run() {
  console.log("🚀 Aave Flash Arbitrage Bot Starting...");
  console.log("Wallet:", wallet.address);

  if (!BUY_ROUTER || !SELL_ROUTER || !TOKEN || !USDC) {
    console.log("⚠️ One or more addresses invalid. Skipping execution.");
    return;
  }

  const amountIn = ethers.parseUnits(AMOUNT_IN, 6); // USDC 6 decimals
  const deadline = Math.floor(Date.now() / 1000) + 60;

  const pathToToken = [USDC, TOKEN];
  const pathToUSDC = [TOKEN, USDC];

  try {
    const tx = await contract.executeFlashArbitrage(
      BUY_ROUTER,
      SELL_ROUTER,
      amountIn,
      pathToToken,
      pathToUSDC,
      deadline
    );

    console.log("🚀 Flash tx sent:", tx.hash);

    const receipt = await tx.wait();

    console.log("✅ Flash arbitrage executed");
    console.log("Gas used:", receipt.gasUsed.toString());

  } catch (err) {
    console.log("⚠️ Execution failed:");
    console.log(err.reason || err.message);
  }
}

run();
