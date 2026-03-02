// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// =============================
// CONFIG
// =============================

const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Tokens (Polygon)
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
};

// Routers
const ROUTERS = {
  SUSHI: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  QUICK: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff"
};

// Your vault
const VAULT = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

// Trade amount (10 USDC example)
const TRADE_AMOUNT = ethers.parseUnits("10", 6);
const SCAN_INTERVAL = 10000;

// =============================
// ABIs
// =============================

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint)"
];

// =============================
// CONTRACTS
// =============================

const sushiRouter = new ethers.Contract(ROUTERS.SUSHI, routerAbi, provider);
const quickRouter = new ethers.Contract(ROUTERS.QUICK, routerAbi, provider);

const usdc = new ethers.Contract(TOKENS.USDC, erc20Abi, provider);

// =============================
// HELPERS
// =============================

function formatUSDC(amount) {
  return Number(ethers.formatUnits(amount, 6)).toFixed(6);
}

async function getBalances() {
  const walletBal = await usdc.balanceOf(wallet.address);
  const vaultBal = await usdc.balanceOf(VAULT);

  console.log("\n💰 Balances:");
  console.log("Wallet USDC:", formatUSDC(walletBal));
  console.log("Vault  USDC:", formatUSDC(vaultBal));
}

async function getQuote(router, path, amountIn) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch (err) {
    console.log("❌ Quote error:", err.reason || err.message);
    return 0n;
  }
}

// =============================
// ARB CHECK
// =============================

async function checkArbitrage() {
  console.log("\n🔄 Scanning for arbitrage...");

  const path = [
    TOKENS.USDC,
    TOKENS.WMATIC,
    TOKENS.WETH,
    TOKENS.USDC
  ];

  try {
    const sushiOut = await getQuote(sushiRouter, path, TRADE_AMOUNT);
    const quickOut = await getQuote(quickRouter, path, TRADE_AMOUNT);

    console.log("Sushi final:", formatUSDC(sushiOut));
    console.log("Quick final:", formatUSDC(quickOut));

    const sushiProfit = sushiOut - TRADE_AMOUNT;
    const quickProfit = quickOut - TRADE_AMOUNT;

    console.log("Sushi profit:", formatUSDC(sushiProfit));
    console.log("Quick profit:", formatUSDC(quickProfit));

    if (sushiProfit > 0n) {
      console.log("⚡ Theoretical Sushi opportunity detected");
    }

    if (quickProfit > 0n) {
      console.log("⚡ Theoretical Quick opportunity detected");
    }

    if (sushiProfit <= 0n && quickProfit <= 0n) {
      console.log("No profitable spread found.");
    }

  } catch (err) {
    console.log("❌ Arb check error:", err.message);
  }
}

// =============================
// MAIN LOOP
// =============================

async function start() {
  console.log("🚀 Real Quote Arbitrage Scanner Started");
  console.log("Wallet:", wallet.address);

  await getBalances();

  while (true) {
    await checkArbitrage();
    await getBalances();
    console.log(`⏳ Next scan in ${SCAN_INTERVAL / 1000}s...\n`);
    await new Promise(res => setTimeout(res, SCAN_INTERVAL));
  }
}

start();
