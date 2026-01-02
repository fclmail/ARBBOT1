// scripts/arbitrage.js
import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// USDC.e
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Routers
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const SCAN_INTERVAL_MS = 5000;
const TRADE_AMOUNT_USDC = 0.1;
const MIN_PROFIT_USDC = 0.00001;
const DRY_RUN = true;

/* =====================================================
   ABIS
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
   SETUP
===================================================== */

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY missing");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet loaded:", wallet.address);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
const quickswap = new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, provider);
const sushiswap = new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

/* =====================================================
   HELPERS
===================================================== */

async function getVaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function getQuote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return 0n;
  }
}

/* =====================================================
   TWO-DEX ARBITRAGE (VERBOSE)
===================================================== */

async function calculateArbitrage(amountUSDC) {
  const amountIn = ethers.parseUnits(amountUSDC.toString(), 6);
  const buyPath = [USDC_ADDRESS, TOKEN_ADDRESS];
  const sellPath = [TOKEN_ADDRESS, USDC_ADDRESS];

  // QUICK → SUSHI
  const quickBuy = await getQuote(quickswap, amountIn, buyPath);
  const quickSell = quickBuy
    ? await getQuote(sushiswap, quickBuy, sellPath)
    : 0n;

  const profitQS =
    Number(ethers.formatUnits(quickSell, 6)) - amountUSDC;

  // SUSHI → QUICK
  const sushiBuy = await getQuote(sushiswap, amountIn, buyPath);
  const sushiSell = sushiBuy
    ? await getQuote(quickswap, sushiBuy, sellPath)
    : 0n;

  const profitSQ =
    Number(ethers.formatUnits(sushiSell, 6)) - amountUSDC;

  return {
    quick: {
      buyTokens: quickBuy,
      sellUSDC: quickSell,
      profit: profitQS
    },
    sushi: {
      buyTokens: sushiBuy,
      sellUSDC: sushiSell,
      profit: profitSQ
    }
  };
}

/* =====================================================
   LOOP
===================================================== */

async function attemptArbitrage() {
  console.log(`🏦 Vault USDC: ${await getVaultBalance()}`);
  console.log(`🏦 Wallet MATIC: ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
  console.log("🔍 Attempting arbitrage...");

  const result = await calculateArbitrage(TRADE_AMOUNT_USDC);

  console.log("🔁 QUICK → SUSHI");
  console.log(`💰 Buy:  ${TRADE_AMOUNT_USDC} USDC → ${result.quick.buyTokens}`);
  console.log(`💵 Sell: ${result.quick.buyTokens} → ${ethers.formatUnits(result.quick.sellUSDC, 6)} USDC`);
  console.log(`💸 Profit: ${result.quick.profit} USDC`);

  console.log("🔁 SUSHI → QUICK");
  console.log(`💰 Buy:  ${TRADE_AMOUNT_USDC} USDC → ${result.sushi.buyTokens}`);
  console.log(`💵 Sell: ${result.sushi.buyTokens} → ${ethers.formatUnits(result.sushi.sellUSDC, 6)} USDC`);
  console.log(`💸 Profit: ${result.sushi.profit} USDC`);

  if (
    result.quick.profit < MIN_PROFIT_USDC &&
    result.sushi.profit < MIN_PROFIT_USDC
  ) {
    console.log("❌ No profitable opportunity");
    return;
  }

  const direction =
    result.quick.profit > result.sushi.profit
      ? "QUICK → SUSHI"
      : "SUSHI → QUICK";

  console.log(`📈 PROFITABLE DIRECTION: ${direction}`);

  if (DRY_RUN) {
    console.log("⚠️ Dry-run: transaction not executed");
    return;
  }

  await arbContract.executeArbitrage(
    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
  );
}

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
