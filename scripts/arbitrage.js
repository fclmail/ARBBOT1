import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const RPC = process.env.RPC_POLYGON;
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!RPC) throw new Error("Missing RPC_POLYGON");
if (!PRIVATE_KEY) throw new Error("Missing WALLET_PRIVATE_KEY");

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONSTANTS ================= */

const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WBTC = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TRADE_AMOUNT_USDC = process.env.TRADE_AMOUNT_USDC || "50";
const SLIPPAGE_BPS = 30; // 0.30%
const SCAN_DELAY = 5000;
const DEADLINE_SECONDS = 60;

/* ================= ABIs ================= */

const vaultAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function POOL() view returns (address)",
  "function minimumProfitUSDC() view returns (uint256)",
  "function usdc() view returns (address)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const poolAbi = [
  "function getReserveData(address asset) view returns (tuple(uint256,uint128,uint128,uint128,uint128,uint128,uint40,address,address,address,address,uint8))"
];

/* ================= CONTRACT INSTANCES ================= */

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

const routers = {
  QuickSwap: new ethers.Contract(ROUTERS.QuickSwap, routerAbi, provider),
  SushiSwap: new ethers.Contract(ROUTERS.SushiSwap, routerAbi, provider)
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function formatUSDC(amount) {
  return Number(ethers.formatUnits(amount, 6)).toFixed(6);
}

function applySlippage(amount) {
  return amount - (amount * BigInt(SLIPPAGE_BPS)) / 10000n;
}

async function getGasCost(txRequest) {
  const gasEstimate = await provider.estimateGas(txRequest);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  return gasEstimate * gasPrice;
}

/* ================= AAVE LIQUIDITY ================= */

async function showAaveLiquidity() {
  const poolAddress = await vault.POOL();
  const pool = new ethers.Contract(poolAddress, poolAbi, provider);

  const reserve = await pool.getReserveData(USDC);
  const availableLiquidity = reserve[0];

  console.log(`🏦 AAVE Pool: ${poolAddress}`);
  console.log(`💰 Available USDC Liquidity: ${formatUSDC(availableLiquidity)} USDC`);
}

/* ================= PROFIT SCANNER ================= */

async function scanOpportunity(amountIn) {

  const pathForward = [USDC, WBTC];
  const pathBack = [WBTC, USDC];

  try {

    // Buy on QuickSwap
    const buyQuote = await routers.QuickSwap.getAmountsOut(amountIn, pathForward);
    const tokenOut = buyQuote[1];

    // Sell on SushiSwap
    const sellQuote = await routers.SushiSwap.getAmountsOut(tokenOut, pathBack);
    const finalUSDC = sellQuote[1];

    const rawProfit = finalUSDC - amountIn;

    if (rawProfit <= 0n) return null;

    const txData = await vault.executeArbitrage.populateTransaction(
      ROUTERS.QuickSwap,
      ROUTERS.SushiSwap,
      amountIn,
      pathForward,
      pathBack,
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );

    const gasCost = await getGasCost({ ...txData, from: wallet.address });

    // Convert gas cost from wei to USDC rough estimate
    const gasCostUSDC = gasCost / 1_000_000_000_000n;

    const netProfit = rawProfit - gasCostUSDC;

    return {
      rawProfit,
      netProfit,
      pathForward,
      pathBack
    };

  } catch {
    return null;
  }
}

/* ================= EXECUTION ================= */

async function execute() {

  console.log("\n🚀 Scanning...");

  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC, 6);

  const contractMin = await vault.minimumProfitUSDC();

  const opportunity = await scanOpportunity(amountIn);

  if (!opportunity) {
    console.log("No opportunity found");
    return;
  }

  console.log(`💵 Raw Profit: ${formatUSDC(opportunity.rawProfit)} USDC`);
  console.log(`💰 Net Profit (after gas): ${formatUSDC(opportunity.netProfit)} USDC`);

  if (opportunity.netProfit < contractMin) {
    console.log("⚠️ Below contract minimum");
    return;
  }

  if (opportunity.netProfit <= 0n) {
    console.log("⚠️ Not profitable after gas");
    return;
  }

  try {

    const tx = await vault.executeArbitrage(
      ROUTERS.QuickSwap,
      ROUTERS.SushiSwap,
      amountIn,
      opportunity.pathForward,
      opportunity.pathBack,
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS,
      { gasLimit: 600000 }
    );

    console.log(`⛓ TX Sent: ${tx.hash}`);

    await tx.wait();

    console.log("✅ Arbitrage executed successfully");

  } catch (err) {
    console.log("❌ Execution failed:", err.reason || err.shortMessage || err);
  }
}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log("🤖 Professional Arbitrage Bot Started\n");

  await showAaveLiquidity();

  while (true) {
    await execute();
    await sleep(SCAN_DELAY);
  }
}

main();
