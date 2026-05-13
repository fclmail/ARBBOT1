import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ========================= CONFIG ========================= */

const RPC = process.env.RPC || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ========================= ADDRESSES ========================= */

const USDC = "0x0000000000000000000000000000000000000000"; // replace
const VAULT = wallet.address;

/* ========================= PAIR INTERFACE ========================= */

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

/* ========================= STATE TRACKING ========================= */

let totalProfit = 0;
let totalLoss = 0;

/* ========================= RESERVE SCAN ========================= */

async function getReserves(pairAddress) {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  return { r0: BigInt(r0), r1: BigInt(r1) };
}

function price(r0, r1) {
  if (r0 === 0n) return 0;
  return Number((r1 * 1000000n) / r0) / 1000000;
}

/* ========================= CURVE SIMULATION ========================= */

function simulateSwap(amountIn, rIn, rOut) {
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * rOut;
  const denominator = rIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

function simulateArb(amount, a, b, c, d) {
  const token = simulateSwap(amount, a, b);
  const out = simulateSwap(token, c, d);
  return out;
}

/* ========================= PROFIT SCORE ========================= */

function computeScore(spread, liquidity) {
  if (spread <= 0) return 0;
  return Math.floor((spread * liquidity) / 1e6);
}

/* ========================= CONFIDENCE → ALLOCATION ========================= */

async function getVaultBalance() {
  const token = new ethers.Contract(USDC, ERC20_ABI, provider);
  const bal = await token.balanceOf(VAULT);
  return BigInt(bal);
}

function confidenceToAllocation(confidence, vaultBalance) {
  return (vaultBalance * BigInt(confidence)) / 100n;
}

/* ========================= EXECUTION (SIMULATED SWAP PLACEHOLDER) ========================= */

async function executeTrade(amount) {
  // simulate execution result variance
  const noise = Math.floor(Math.random() * 80) - 20;
  return Number(amount) + noise;
}

/* ========================= CORE STRATEGY ========================= */

async function runVaultArbitrage(pairA, pairB) {

  /* ========== RESERVE SCAN ========== */

  const A = await getReserves(pairA);
  const B = await getReserves(pairB);

  const priceA = price(A.r0, A.r1);
  const priceB = price(B.r0, B.r1);

  const spread = Math.abs(priceA - priceB);

  console.log("🔎 RESERVE_SCAN");
  console.log(`DEXA:${priceA.toFixed(2)}`);
  console.log(`DEXB:${priceB.toFixed(2)}`);
  console.log(`SPREAD:${spread.toFixed(2)}\n`);

  /* ========== PROFIT SCORE ========== */

  const liquidity = Number(A.r0 + A.r1 + B.r0 + B.r1);
  const score = computeScore(spread, liquidity);

  console.log(`📊 PROFIT_SCORE: ${score}\n`);

  if (score === 0) return;

  /* ========== CONFIDENCE ========== */

  let confidence =
    score > 800 ? 80 :
    score > 500 ? 50 :
    score > 200 ? 25 : 10;

  const vaultBalance = await getVaultBalance();

  const allocation = confidenceToAllocation(confidence, vaultBalance);

  console.log(`🎯 CONFIDENCE: ${confidence}%`);
  console.log(`💰 ALLOCATION: ${Number(allocation / 1_000_000n)} USDC\n`);

  /* ========== CURVE SIMULATION (FIND RESULT) ========== */

  const simulatedOut =
    simulateArb(
      allocation,
      A.r0,
      A.r1,
      B.r0,
      B.r1
    );

  const profit = Number(simulatedOut - allocation);

  /* ========== EXECUTION ========== */

  console.log("🔥 EXECUTING VAULT TRADE\n");

  const result = await executeTrade(Number(allocation));

  const finalPnL = result - Number(allocation);

  if (finalPnL >= 0) {
    totalProfit += finalPnL;
  } else {
    totalLoss += Math.abs(finalPnL);
  }

  console.log(`RESULT: ${finalPnL >= 0 ? "+" : ""}${finalPnL} USDC`);
  console.log(`TOTAL PROFIT: +${totalProfit} USDC`);
  console.log(`TOTAL LOSS: -${totalLoss} USDC\n`);
}

/* ========================= LOOP ENGINE ========================= */

async function main() {

  const pairA = "0x0000000000000000000000000000000000000000";
  const pairB = "0x0000000000000000000000000000000000000000";

  while (true) {
    try {
      await runVaultArbitrage(pairA, pairB);
    } catch (e) {
      console.log("⚠️ ERROR:", e.message);
    }

    await new Promise(r => setTimeout(r, 3000));
  }
}

main();
