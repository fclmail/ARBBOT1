import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= CONFIG ================= */
dotenv.config({ override: false });

/*
   CI SAFE RPC LOADER
   Priority:
   1. RPC_POLYGON
   2. POLYGON_RPC
   3. RPC_URL
   4. Fallback public RPC
*/

let RPC_POLYGON =
  (process.env.RPC_POLYGON ||
   process.env.POLYGON_RPC ||
   process.env.RPC_URL ||
   "https://polygon-rpc.com").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
   process.env.PRIVATE_KEY ||
   "").trim();

if (!WALLET_PRIVATE_KEY)
  throw new Error("WALLET_PRIVATE_KEY is missing or empty");

/* ================= PROVIDER INIT WITH FETCH TEST ================= */

async function createProvider(rpcUrl) {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Force network detection (real fetch test)
    await provider.getBlockNumber();

    console.log("✅ RPC Connected:", rpcUrl);
    return provider;
  } catch (err) {
    console.log("⚠️ RPC failed:", rpcUrl);
    throw err;
  }
}

const provider = await createProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= REST OF YOUR ORIGINAL CODE ================= */
/* NOTHING ELSE MODIFIED BELOW */

const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || .0020);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 4000);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
let MIN_SWEEP_AMOUNT = Number(process.env.MIN_SWEEP_AMOUNT || 0.000001);
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";

const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? Number(process.env.GAS_PRICE_GWEI) : undefined;
const GAS_LIMIT = process.env.GAS_LIMIT ? Number(process.env.GAS_LIMIT) : undefined;
const TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 1);

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
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
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= START BOT ================= */

(async () => {
  console.log("🚀 Arbitrage bot started");

  const network = await provider.getNetwork();
  console.log("🌐 Chain ID:", network.chainId.toString());

  const block = await provider.getBlockNumber();
  console.log("📦 Current Block:", block);

  const balance = await provider.getBalance(wallet.address);
  console.log("💎 Wallet MATIC:", ethers.formatUnits(balance, 18));

  console.log("🤖 Bot ready. Beginning scan loop...\n");

  while (true) {
    try {
      console.log("🔍 Scan cycle running...");
    } catch (err) {
      console.log("⚠️ Scan error:", err?.message ?? err);
    }
    await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
  }
})();
