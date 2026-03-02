// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ==========================
// CONFIG
// ==========================

const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC || !PRIVATE_KEY) {
  console.error("❌ Missing RPC_URL or PRIVATE_KEY in env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Polygon Tokens (lowercase safe)
const TOKENS = {
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

// Corrected Router Addresses (lowercase)
const ROUTERS = {
  SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff"
};

// Vault
const VAULT = "0xab046582a36d00f4921c447db9b77644b5e43c95";

// Trade amount (10 USDC)
const TRADE_AMOUNT = ethers.parseUnits("10", 6);
const SCAN_INTERVAL = 10000;

// ==========================
// ABIs
// ==========================

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint)"
];

// ==========================
// CONTRACTS
// ==========================

const sushiRouter = new ethers.Contract(ROUTERS.SUSHI, routerAbi, provider);
const quickRouter = new ethers.Contract(ROUTERS.QUICK, routerAbi, provider);

const usdc = new ethers.Contract(TOKENS.USDC, erc20Abi, provider);

// ==========================
// HELPERS
// ==========================

function formatUSDC(amount) {
  return Number(ethers.formatUnits(amount, 6)).toFixed(6);
}

async function getBalances() {
  try {
    const walletBal = await usdc.balanceOf(wallet.address);
    const vaultBal = await usdc.balanceOf(VAULT);

    console.log("\n💰 Balances:");
    console.log("Wallet USDC:", formatUSDC(walletBal));
    console.log("Vault  USDC:", formatUSDC(vaultBal));
  } catch (err) {
    console.log("❌ Balance fetch error:", err.message);
  }
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

// ==========================
// ARBITRAGE CHECK
// ==========================

async function checkArbitrage() {
  console.log("\n🔄 Scanning for arbitrage...");

  const forwardPath = [
    TOKENS.USDC,
    TOKENS.WETH
  ];

  const reversePath = [
    TOKENS.WETH,
    TOKENS.USDC
  ];

  try {
    // Sushi → Quick direction
    const sushiOut = await getQuote(sushiRouter, forwardPath, TRADE_AMOUNT);
    const quickBack = await getQuote(quickRouter, reversePath, sushiOut);

    const profit1 = quickBack - TRADE_AMOUNT;

    console.log("\nRoute: Sushi → Quick");
    console.log("Final:", formatUSDC(quickBack));
    console.log("Profit:", formatUSDC(profit1));

    // Quick → Sushi direction
    const quickOut = await getQuote(quickRouter, forwardPath, TRADE_AMOUNT);
    const sushiBack = await getQuote(sushiRouter, reversePath, quickOut);

    const profit2 = sushiBack - TRADE_AMOUNT;

    console.log("\nRoute: Quick → Sushi");
    console.log("Final:", formatUSDC(sushiBack));
    console.log("Profit:", formatUSDC(profit2));

    if (profit1 > 0n) {
      console.log("⚡ Theoretical opportunity: Sushi → Quick");
    }

    if (profit2 > 0n) {
      console.log("⚡ Theoretical opportunity: Quick → Sushi");
    }

    if (profit1 <= 0n && profit2 <= 0n) {
      console.log("\nNo profitable spread found.");
    }

  } catch (err) {
    console.log("❌ Arb check error:", err.message);
  }
}

// ==========================
// MAIN LOOP
// ==========================

async function start() {
  console.log("🚀 Real Quote Arbitrage Scanner Started");
  console.log("Wallet:", wallet.address);

  await getBalances();

  while (true) {
    await checkArbitrage();
    await getBalances();
    console.log(`\n⏳ Next scan in ${SCAN_INTERVAL / 1000}s...\n`);
    await new Promise(res => setTimeout(res, SCAN_INTERVAL));
  }
}

start();
