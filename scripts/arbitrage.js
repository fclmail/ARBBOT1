// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const RPC_URL = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory)"
];

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6 decimals
const WETH = "0x172370d5cd63279efa6d502dab29171933a610af"; // 18 decimals

// Hardcoded vault address
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6); // 1000 USDC
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", 6);   // 0.01 USDC

// -------------------- CONTRACTS --------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);

const VAULT_ABI = ["function depositProfit(uint amount) external"];
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];
const usdcContract = new ethers.Contract(USDC, ERC20_ABI, provider);

// -------------------- UTILS --------------------
async function getAmountsOut(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts;
  } catch (err) {
    console.error("getAmountsOut error:", err);
    return null;
  }
}

async function getVaultUSDCBalance() {
  try {
    const balance = await usdcContract.balanceOf(VAULT_ADDRESS);
    return balance;
  } catch {
    return ethers.parseUnits("0", 6);
  }
}

async function getWalletMaticBalance() {
  try {
    const balance = await provider.getBalance(wallet.address);
    return balance;
  } catch {
    return ethers.parseEther("0");
  }
}

function formatUSDC(amount) {
  return Number(ethers.formatUnits(amount, 6)).toFixed(6);
}

function formatETH(amount) {
  return Number(ethers.formatUnits(amount, 18)).toFixed(6);
}

// -------------------- SIMULATION --------------------
async function simulateArbitrage({
  routerBuy,
  routerSell,
  amountInUSDC,
  minProfitUSDC,
  safetyBps = 8500
}) {
  try {
    // 1️⃣ USDC -> WETH
    const buyAmounts = await getAmountsOut(routerBuy, amountInUSDC, [USDC, WETH]);
    if (!buyAmounts) return { profitable: false };
    const wethOut = buyAmounts[1];
    if (wethOut === 0n) return { profitable: false };

    // 2️⃣ WETH -> USDC
    const sellAmounts = await getAmountsOut(routerSell, wethOut, [WETH, USDC]);
    if (!sellAmounts) return { profitable: false };
    const usdcOut = sellAmounts[1];
    if (usdcOut <= amountInUSDC) return { profitable: false };

    // 3️⃣ Profits
    const rawProfit = usdcOut - amountInUSDC;
    const adjustedProfit = (rawProfit * BigInt(safetyBps)) / 10000n;

    return {
      profitable: adjustedProfit >= minProfitUSDC,
      rawProfit,
      adjustedProfit,
      wethOut,
      usdcOut
    };
  } catch (err) {
    console.error("Simulation error:", err.message);
    return { profitable: false };
  }
}

// -------------------- ARBITRAGE SCAN --------------------
async function scanArbitrage() {
  const walletMatic = await getWalletMaticBalance();
  const vaultBalanceRaw = await getVaultUSDCBalance();
  const vaultBalance = formatUSDC(vaultBalanceRaw);

  console.log(`⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);
  console.log(`🏦 Vault USDC: ${vaultBalance}`);
  console.log(`👛 Wallet MATIC: ${formatETH(walletMatic)}`);

  const pairs = [
    { buyRouter: quickRouter, buyDEX: "QuickSwap", sellRouter: sushiRouter, sellDEX: "SushiSwap" },
    { buyRouter: sushiRouter, buyDEX: "SushiSwap", sellRouter: quickRouter, sellDEX: "QuickSwap" }
  ];

  let anyOpportunity = false;

  for (const pair of pairs) {
    const result = await simulateArbitrage({
      routerBuy: pair.buyRouter,
      routerSell: pair.sellRouter,
      amountInUSDC: TRADE_AMOUNT_USDC,
      minProfitUSDC: MIN_PROFIT_USDC
    });

    if (!result.profitable) {
      console.log(`🔍 ${pair.buyDEX} ➜ ${pair.sellDEX} ❌ No profit opportunity`);
      continue;
    }

    anyOpportunity = true;

    const buyPrice = Number(ethers.formatUnits(TRADE_AMOUNT_USDC, 6)) / Number(ethers.formatUnits(result.wethOut, 18));
    const sellPrice = Number(ethers.formatUnits(result.usdcOut, 6)) / Number(ethers.formatUnits(result.wethOut, 18));
    const priceDiffPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

    console.log(`🔍 ${pair.buyDEX} ➜ ${pair.sellDEX}`);
    console.log(`📈 ${pair.buyDEX} price: ${buyPrice.toFixed(6)} USDC/WETH`);
    console.log(`📉 ${pair.sellDEX} price: ${sellPrice.toFixed(6)} USDC/WETH`);
    console.log(`💵 Price-ratio diff: ${priceDiffPercent.toFixed(3)} %`);
    console.log(`💵 Gross profit: ${formatUSDC(result.rawProfit)} USDC`);
    console.log(`💵 Adjusted profit: ${formatUSDC(result.adjustedProfit)} USDC`);
    console.log(`✅ MIN PROFIT = ${formatUSDC(MIN_PROFIT_USDC)} USDC satisfied`);
    console.log(`🚀 Executing arbitrage...`);

    const vaultBefore = await getVaultUSDCBalance();
    console.log(`💰 Vault USDC before: ${formatUSDC(vaultBefore)}`);

    try {
      const tx = await vaultContract.depositProfit(result.usdcOut);
      console.log(`📤 Tx hash: ${tx.hash}`);
      await tx.wait();
      const vaultAfter = await getVaultUSDCBalance();
      console.log(`💰 Vault USDC after: ${formatUSDC(vaultAfter)}`);
    } catch (err) {
      console.error("⚠️ Arbitrage execution failed:", err);
    }
  }

  if (!anyOpportunity) console.log(`⚠️ No executable arbitrage this cycle`);
}

// -------------------- LOOP --------------------
async function startLoop() {
  while (true) {
    try {
      await scanArbitrage();
    } catch (err) {
      console.error("Error in arbitrage scan:", err);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

// -------------------- MAIN --------------------
startLoop();
