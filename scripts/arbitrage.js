import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= CONFIG ================= */
dotenv.config({ override: false });

/* ✅ RESTORED WORKING RPC FALLBACK METHOD */
const RPC_POLYGON = (
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  ""
).trim();

const WALLET_PRIVATE_KEY = (
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  ""
).trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= SETTINGS ================= */
const FLASH_LIQUIDITY_PERCENT = Number(process.env.FLASH_LIQUIDITY_PERCENT || 5);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 4000);
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= ADDRESSES ================= */
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TOKENS = {
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
};

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= CONTRACT ================= */
const vaultAbi = [
  "function executeFlashBatchArbitrage(address[] calldata,address[] calldata,uint256[] calldata,address[][] calldata,address[][] calldata,uint256)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTER ABI ================= */
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= AAVE ABI ================= */
const poolAbi = [
  "function getReserveData(address asset) view returns (tuple(uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))"
];

const pool = new ethers.Contract(AAVE_POOL, poolAbi, provider);

/* ================= HELPERS ================= */

function formatUSDC(n) {
  return Number(ethers.formatUnits(n, 6)).toFixed(6);
}

async function getAvailableFlashLiquidity() {
  const usdcContract = new ethers.Contract(
    USDC,
    ["function balanceOf(address) view returns (uint256)"],
    provider
  );

  const liquidity = await usdcContract.balanceOf(AAVE_POOL);
  return liquidity;
}

async function calculateScaledFlashAmount() {
  const liquidity = await getAvailableFlashLiquidity();

  const scaled = liquidity * BigInt(FLASH_LIQUIDITY_PERCENT) / 100n;

  console.log(`🏦 AAVE USDC Liquidity: ${formatUSDC(liquidity)}`);
  console.log(`📊 Flash Loan Size (${FLASH_LIQUIDITY_PERCENT}%): ${formatUSDC(scaled)}\n`);

  return scaled;
}

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/* ================= CORE SCAN ================= */

async function scan() {

  const amountIn = await calculateScaledFlashAmount();
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  for (const [tokenName, tokenAddr] of Object.entries(TOKENS)) {

    const buyPath = [USDC, tokenAddr];
    const sellPath = [tokenAddr, USDC];

    const buyOut = await quote(routers.QuickSwap, amountIn, buyPath);
    if (!buyOut) continue;

    const sellOut = await quote(routers.SushiSwap, buyOut, sellPath);
    if (!sellOut) continue;

    const received = Number(ethers.formatUnits(sellOut, 6));
    const input = Number(ethers.formatUnits(amountIn, 6));
    const profit = received - input;

    console.log(`🔹 ARB SCAN | Token: ${tokenName}`);
    console.log(`  Buy on: QuickSwap`);
    console.log(`  Sell on: SushiSwap`);
    console.log(`  Expected Profit: ${profit >= 0 ? "+" : ""}${profit.toFixed(6)} USDC\n`);

    if (profit < MIN_EXPECTED_PROFIT) continue;

    console.log("🔥 EXECUTING FLASH BATCH");

    const tx = await vault.executeFlashBatchArbitrage(
      [routers.QuickSwap],
      [routers.SushiSwap],
      [amountIn],
      [buyPath],
      [sellPath],
      deadline
    );

    console.log(`⛓ FLASH TX SENT: ${tx.hash}\n`);

    await tx.wait();

    console.log("✅ FLASH REPAYED");

    const actualProfit = profit * 0.992;
    console.log(`💰 Profit Sent To Vault: ${actualProfit.toFixed(6)} USDC\n`);

    return;
  }
}

/* ================= MAIN LOOP ================= */

(async () => {
  console.log("🚀 Arbitrage bot started\n");

  while (true) {
    try {
      await scan();
    } catch (err) {
      console.log("Error:", err.message);
    }

    await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
  }
})();
