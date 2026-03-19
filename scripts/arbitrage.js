import dotenv from "dotenv";
import { ethers } from "ethers";
import { abi as ERC20Abi } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { abi as IWETHAbi } from "@openzeppelin/contracts/build/contracts/IWETH.json";

dotenv.config({ override: false });

/* ================= ENV ================= */
const RPC_POLYGON = (process.env.RPC_POLYGON || process.env.POLYGON_RPC || "").trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || "").trim();
const OWNER_ADDRESS = (process.env.OWNER_ADDRESS || "").trim();
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC Polygon
const WMATIC_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WMATIC Polygon

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACTS ================= */
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20Abi, wallet);
const wmatic = new ethers.Contract(WMATIC_ADDRESS, IWETHAbi, wallet);

/* ================= CONFIG ================= */
const THRESHOLD_USDC = ethers.parseUnits(".3", 6); // e.g., 10 USDC
const SWAP_PERCENT = 0.01; // % of balance to convert on threshold
const MIN_PROFIT_USD = ethers.parseUnits("0.01", 6); // minimum profit to act
const SCAN_INTERVAL_MS = 3000;

/* ================= UTILS ================= */
async function swapUSDCtoWMATIC(amount) {
  // Approve router if needed
  // Here you would call Uniswap/Sushi router contract swapExactTokensForTokens
  console.log(`🔹 SWAP USDC → WMATIC: ${ethers.formatUnits(amount, 6)} USDC`);
  // return amount of WMATIC received
  return ethers.parseUnits("0.01", 18); // placeholder for actual swap result
}

async function unwrapWMATIC(amount) {
  console.log(`🔹 UNWRAP WMATIC → POL: ${ethers.formatUnits(amount, 18)} WMATIC`);
  // Call WMATIC.withdraw
  // await wmatic.withdraw(amount);
  // Send POL (MATIC) to owner wallet
  console.log(`🔹 SENT POL to owner: ${OWNER_ADDRESS}`);
}

async function getUSDCBalance() {
  return await usdc.balanceOf(wallet.address);
}

async function getWMATICBalance() {
  return await wmatic.balanceOf(wallet.address);
}

/* ================= MAIN SCAN LOOP ================= */
let totalProfitsUSDC = ethers.parseUnits("0", 6);
let totalProfitsWMATIC = ethers.parseUnits("0", 18);

async function scanForArbitrage() {
  try {
    // 1. Simulate arbitrage opportunities
    // Placeholder: Detect arbitrage
    const arbitrageDetected = Math.random() < 0.5; // random for demo
    const profit = ethers.parseUnits((Math.random() * 0.05).toFixed(6), 6); // simulated profit in USDC

    if (arbitrageDetected && profit.gte(MIN_PROFIT_USD)) {
      console.log(`💰 Arbitrage opportunity detected! PROFIT FOUND: ${ethers.formatUnits(profit, 6)} USDC`);
      totalProfitsUSDC = totalProfitsUSDC + profit;
    }

    // 2. Check threshold for USDC → WMATIC sweep
    const usdcBalance = await getUSDCBalance();
    if (usdcBalance.gte(THRESHOLD_USDC)) {
      const swapAmount = usdcBalance * SWAP_PERCENT;
      const wmaticReceived = await swapUSDCtoWMATIC(swapAmount);
      await unwrapWMATIC(wmaticReceived);
      totalProfitsWMATIC += wmaticReceived;
      console.log(`🔹 MICRO AGGREGATION initiated...`);
      console.log(`Sweep completed. Updated balances: USDC=${ethers.formatUnits(usdcBalance,6)}, WMATIC=${ethers.formatUnits(await getWMATICBalance(),18)}`);
    }

    console.log(`💹 TOTAL PROFITS: USDC=${ethers.formatUnits(totalProfitsUSDC,6)}, WMATIC=${ethers.formatUnits(totalProfitsWMATIC,18)}`);
  } catch (err) {
    console.error("Scan error:", err.message || err);
  }
}

/* ================= RUN LOOP ================= */
async function mainLoop() {
  console.log("🚀 Starting continuous arbitrage scan...");
  while (true) {
    await scanForArbitrage();
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

mainLoop();
