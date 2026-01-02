// scripts/arbitrage.js
import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ADDRESSES (REPLACE THESE 3)
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TOKEN_ADDRESS = "0x172370d5cd63279efa6d502dab29171933a610af";

// STABLES / BASES
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// ROUTERS
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// BOT SETTINGS
const SCAN_INTERVAL_MS = 5000;
const TRADE_AMOUNT_USDC = 0.1;
const MIN_PROFIT_USDC = 0.001;
const DRY_RUN = true;

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
   FALLBACK PATHS
===================================================== */

const BUY_PATHS = [
  [USDC_ADDRESS, TOKEN_ADDRESS],
  [USDC_ADDRESS, WMATIC, TOKEN_ADDRESS],
  [USDC_ADDRESS, WETH, TOKEN_ADDRESS],
  [USDC_ADDRESS, WMATIC, WETH, TOKEN_ADDRESS]
];

const SELL_PATHS = [
  [TOKEN_ADDRESS, USDC_ADDRESS],
  [TOKEN_ADDRESS, WMATIC, USDC_ADDRESS],
  [TOKEN_ADDRESS, WETH, USDC_ADDRESS],
  [TOKEN_ADDRESS, WETH, WMATIC, USDC_ADDRESS]
];

/* =====================================================
   TWO-DEX ARBITRAGE (ALL PATHS)
===================================================== */

async function calculateSide(routerBuy, routerSell, amountUSDC) {
  const amountIn = ethers.parseUnits(amountUSDC.toString(), 6);

  let best = {
    buyTokens: 0n,
    sellUSDC: 0n,
    profit: -Infinity,
    pathIndex: -1
  };

  for (let i = 0; i < BUY_PATHS.length; i++) {
    const buy = await getQuote(routerBuy, amountIn, BUY_PATHS[i]);
    if (buy === 0n) continue;

    const sell = await getQuote(routerSell, buy, SELL_PATHS[i]);
    if (sell === 0n) continue;

    const profit =
      Number(ethers.formatUnits(sell, 6)) - amountUSDC;

    if (profit > best.profit) {
      best = { buyTokens: buy, sellUSDC: sell, profit, pathIndex: i };
    }
  }

  return best;
}

/* =====================================================
   LOOP
===================================================== */

async function attemptArbitrage() {
  console.log(`🏦 Vault USDC: ${await getVaultBalance()}`);
  console.log(`🏦 Wallet MATIC: ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
  console.log("🔍 Attempting arbitrage...");

  const quickToSushi = await calculateSide(quickswap, sushiswap, TRADE_AMOUNT_USDC);
  const sushiToQuick = await calculateSide(sushiswap, quickswap, TRADE_AMOUNT_USDC);

  console.log("🔁 QUICK → SUSHI");
  console.log(`💰 Buy:  ${TRADE_AMOUNT_USDC} USDC → ${quickToSushi.buyTokens}`);
  console.log(`💵 Sell: ${quickToSushi.buyTokens} → ${ethers.formatUnits(quickToSushi.sellUSDC, 6)} USDC`);
  console.log(`💸 Profit: ${quickToSushi.profit} USDC`);

  console.log("🔁 SUSHI → QUICK");
  console.log(`💰 Buy:  ${TRADE_AMOUNT_USDC} USDC → ${sushiToQuick.buyTokens}`);
  console.log(`💵 Sell: ${sushiToQuick.buyTokens} → ${ethers.formatUnits(sushiToQuick.sellUSDC, 6)} USDC`);
  console.log(`💸 Profit: ${sushiToQuick.profit} USDC`);

  if (
    quickToSushi.profit < MIN_PROFIT_USDC &&
    sushiToQuick.profit < MIN_PROFIT_USDC
  ) {
    console.log("❌ No profitable opportunity");
    return;
  }

  const best =
    quickToSushi.profit > sushiToQuick.profit
      ? { dir: "QUICK → SUSHI", data: quickToSushi }
      : { dir: "SUSHI → QUICK", data: sushiToQuick };

  console.log(`📈 PROFITABLE DIRECTION: ${best.dir}`);
  console.log(`🛣 Path index used: ${best.data.pathIndex}`);

  if (DRY_RUN) {
    console.log("⚠️ Dry-run: transaction not executed");
    return;
  }

  await arbContract.executeArbitrage(
    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
  );
}

/* =====================================================
   MAIN
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
