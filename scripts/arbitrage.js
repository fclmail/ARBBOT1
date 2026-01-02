// scripts/arbitrage.js
import { ethers } from "ethers";

/* =====================================================
   CONFIGURATION
===================================================== */

const RPC_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// CONTRACTS / ADDRESSES
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19"; // REPLACE
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";       // REPLACE
const TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";       // REPLACE

// USDC.e Polygon
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

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

async function getQuote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return 0n;
  }
}

/* =====================================================
   TWO-DEX ARBITRAGE (FULL DISPLAY)
===================================================== */

async function calculateArbitrage(amountUSDC) {
  const amountIn = ethers.parseUnits(amountUSDC.toString(), 6);
  const buyPath = [USDC_ADDRESS, TOKEN_ADDRESS];
  const sellPath = [TOKEN_ADDRESS, USDC_ADDRESS];

  // QUICK → SUSHI
  const quickBuyTokens = await getQuote(quickswap, amountIn, buyPath);
  const sushiSellUSDC = quickBuyTokens
    ? await getQuote(sushiswap, quickBuyTokens, sellPath)
    : 0n;

  const profitQS =
    Number(ethers.formatUnits(sushiSellUSDC, 6)) - amountUSDC;

  // SUSHI → QUICK
  const sushiBuyTokens = await getQuote(sushiswap, amountIn, buyPath);
  const quickSellUSDC = sushiBuyTokens
    ? await getQuote(quickswap, sushiBuyTokens, sellPath)
    : 0n;

  const profitSQ =
    Number(ethers.formatUnits(quickSellUSDC, 6)) - amountUSDC;

  if (profitQS > profitSQ && profitQS > MIN_PROFIT_USDC) {
    return {
      direction: "QUICK → SUSHI",
      buyTokens: quickBuyTokens,
      sellUSDC: sushiSellUSDC,
      expectedProfit: profitQS
    };
  }

  if (profitSQ > profitQS && profitSQ > MIN_PROFIT_USDC) {
    return {
      direction: "SUSHI → QUICK",
      buyTokens: sushiBuyTokens,
      sellUSDC: quickSellUSDC,
      expectedProfit: profitSQ
    };
  }

  return null;
}

/* =====================================================
   ARBITRAGE ATTEMPT (RESTORED LOGS)
===================================================== */

async function attemptArbitrage() {
  console.log(`🏦 Vault USDC: ${await getVaultBalance()}`);
  console.log(`🏦 Wallet MATIC: ${ethers.formatEther(await provider.getBalance(wallet.address))}`);

  console.log("🔍 Attempting arbitrage...");

  const arb = await calculateArbitrage(TRADE_AMOUNT_USDC);

  if (!arb) {
    console.log("❌ No profitable opportunity");
    return;
  }

  console.log(`📈 Direction: ${arb.direction}`);
  console.log(`💰 Expected buy: ${TRADE_AMOUNT_USDC} USDC -> ${arb.buyTokens}`);
  console.log(
    `💵 Expected sell: ${arb.buyTokens} -> ${ethers.formatUnits(
      arb.sellUSDC,
      6
    )} USDC`
  );
  console.log(`💸 Expected profit: ${arb.expectedProfit} USDC`);

  if (DRY_RUN) {
    console.log("⚠️ Dry-run: transaction not executed");
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
