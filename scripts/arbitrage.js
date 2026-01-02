// scripts/arbitrage.js
import { ethers } from "ethers";

/* =====================================================
   CONFIGURATION
===================================================== */

// HARD-CODED POLYGON RPC
const RPC_URL = "https://polygon-rpc.com";

// PRIVATE KEY FROM SECRETS
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ARBITRAGE CONTRACT
const CONTRACT_ADDRESS = "0xYourContractAddressHere"; // <-- REPLACE

// VAULT & TOKENS
const VAULT_ADDRESS = "0xYourVaultAddressHere"; // <-- REPLACE
const USDC_ADDRESS  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e
const TOKEN_ADDRESS = "0xYourTokenAddressHere"; // <-- TOKEN YOU ARB

// DEX ROUTERS
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// BOT SETTINGS
const DRY_RUN = true;
const SCAN_INTERVAL_MS = 5000;
const TRADE_AMOUNT_USDC = 0.1;
const MIN_PROFIT_USDC = 0.001;

/* =====================================================
   ABIs
===================================================== */
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const ARB_ABI = [
  "function executeArbitrage(uint256 amount) external"
];

/* =====================================================
   PROVIDER / WALLET
===================================================== */
if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY missing");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet loaded:", wallet.address);

/* =====================================================
   CONTRACTS
===================================================== */
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

const quickswap = new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, provider);
const sushiswap = new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider);

/* =====================================================
   VAULT BALANCE (FIXED)
===================================================== */
async function getVaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

/* =====================================================
   PRICE HELPERS
===================================================== */
async function getDexQuote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return 0n;
  }
}

/* =====================================================
   TWO-DEX ARBITRAGE LOGIC (BOTH DIRECTIONS)
===================================================== */
async function calculateArbitrage(amountUSDC) {
  const amountIn = ethers.parseUnits(amountUSDC.toString(), 6);

  // Paths
  const buyPath  = [USDC_ADDRESS, TOKEN_ADDRESS];
  const sellPath = [TOKEN_ADDRESS, USDC_ADDRESS];

  // ---- BUY QUICK → SELL SUSHI ----
  const tokenFromQuick = await getDexQuote(quickswap, amountIn, buyPath);
  const usdcFromSushi  = tokenFromQuick
    ? await getDexQuote(sushiswap, tokenFromQuick, sellPath)
    : 0n;

  const profitQS = Number(ethers.formatUnits(usdcFromSushi, 6)) - amountUSDC;

  // ---- BUY SUSHI → SELL QUICK ----
  const tokenFromSushi = await getDexQuote(sushiswap, amountIn, buyPath);
  const usdcFromQuick  = tokenFromSushi
    ? await getDexQuote(quickswap, tokenFromSushi, sellPath)
    : 0n;

  const profitSQ = Number(ethers.formatUnits(usdcFromQuick, 6)) - amountUSDC;

  // Decide best direction
  if (profitQS > profitSQ && profitQS > MIN_PROFIT_USDC) {
    return {
      direction: "QUICK → SUSHI",
      expectedProfit: profitQS
    };
  }

  if (profitSQ > profitQS && profitSQ > MIN_PROFIT_USDC) {
    return {
      direction: "SUSHI → QUICK",
      expectedProfit: profitSQ
    };
  }

  return null;
}

/* =====================================================
   ARBITRAGE ATTEMPT
===================================================== */
async function attemptArbitrage() {
  console.log(`🏦 Vault USDC: ${await getVaultBalance()}`);
  console.log(`🏦 Wallet MATIC: ${ethers.formatEther(await provider.getBalance(wallet.address))}`);

  console.log("🔍 Scanning arbitrage...");
  const arb = await calculateArbitrage(TRADE_AMOUNT_USDC);

  if (!arb) {
    console.log("❌ No profitable arbitrage");
    return;
  }

  console.log(`✅ Opportunity found: ${arb.direction}`);
  console.log(`💸 Expected profit: ${arb.expectedProfit} USDC`);

  if (DRY_RUN) {
    console.log("⚠️ Dry-run: trade not executed");
    return;
  }

  try {
    const tx = await arbContract.executeArbitrage(
      ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
    );
    console.log("🚀 Tx sent:", tx.hash);
    await tx.wait();
    console.log("✅ Arbitrage executed");
  } catch (err) {
    console.error("❌ Execution failed:", err.message);
  }
}

/* =====================================================
   MAIN LOOP
===================================================== */
async function main() {
  console.log("⏱ Polygon Arb Bot Started");

  while (true) {
    try {
      await attemptArbitrage();
    } catch (err) {
      console.error("❌ Loop error:", err.message);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
