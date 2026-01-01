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

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

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

// -------------------- SIMULATION LOGIC --------------------
/**
 * Simulate a full arbitrage path and return REAL profit
 */
async function simulateArbitrage({
  dexBuy,
  dexSell,
  routerBuy,
  routerSell,
  usdc,
  weth,
  amountInUSDC,
  minProfitUSDC,
  safetyBps = 8500 // 85% safety margin
}) {
  try {
    // 1️⃣ USDC -> WETH on buy DEX
    const amountsOutBuy = await routerBuy.getAmountsOut(amountInUSDC, [usdc, weth]);
    const wethOut = amountsOutBuy[1];
    if (wethOut === 0n) return { profitable: false };

    // 2️⃣ WETH -> USDC on sell DEX
    const amountsOutSell = await routerSell.getAmountsOut(wethOut, [weth, usdc]);
    const usdcOut = amountsOutSell[1];
    if (usdcOut <= amountInUSDC) return { profitable: false };

    // 3️⃣ Raw profit
    const rawProfit = usdcOut - amountInUSDC;

    // 4️⃣ Apply safety margin
    const adjustedProfit = (rawProfit * BigInt(safetyBps)) / 10000n;

    return {
      profitable: adjustedProfit >= minProfitUSDC,
      rawProfit,
      adjustedProfit,
      usdcOut,
      wethOut
    };
  } catch (err) {
    console.error("Simulation error:", err.message);
    return { profitable: false };
  }
}

// -------------------- ARBITRAGE --------------------
async function scanArbitrage() {
  const walletMatic = await getWalletMaticBalance();
  const vaultBalanceRaw = await getVaultUSDCBalance();
  const vaultBalance = Number(ethers.formatUnits(vaultBalanceRaw, 6)).toFixed(6);

  console.log(`⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);
  console.log(`🏦 Vault USDC: ${vaultBalance}`);
  console.log(`👛 Wallet MATIC: ${Number(ethers.formatUnits(walletMatic, 18)).toFixed(6)}`);

  const pairs = [
    { buyRouter: quickRouter, buyDEX: "QuickSwap", sellRouter: sushiRouter, sellDEX: "SushiSwap" },
    { buyRouter: sushiRouter, buyDEX: "SushiSwap", sellRouter: quickRouter, sellDEX: "QuickSwap" }
  ];

  let anyOpportunity = false;

  for (const pair of pairs) {
    const result = await simulateArbitrage({
      dexBuy: pair.buyDEX,
      dexSell: pair.sellDEX,
      routerBuy: pair.buyRouter,
      routerSell: pair.sellRouter,
      usdc: USDC,
      weth: WETH,
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
    console.log(`💵 Gross profit: ${Number(ethers.formatUnits(result.rawProfit, 6)).toFixed(6)} USDC`);
    console.log(`💵 Adjusted profit: ${Number(ethers.formatUnits(result.adjustedProfit, 6)).toFixed(6)} USDC`);
    console.log(`✅ MIN PROFIT = ${Number(ethers.formatUnits(MIN_PROFIT_USDC, 6))} USDC satisfied`);
    console.log(`🚀 Executing arbitrage...`);

    const vaultBefore = await getVaultUSDCBalance();
    console.log(`💰 Vault USDC before: ${Number(ethers.formatUnits(vaultBefore, 6)).toFixed(6)}`);

    try {
      const tx = await vaultContract.depositProfit(result.usdcOut);
      console.log(`📤 Tx hash: ${tx.hash}`);
      await tx.wait();
      const vaultAfter = await getVaultUSDCBalance();
      console.log(`💰 Vault USDC after: ${Number(ethers.formatUnits(vaultAfter, 6)).toFixed(6)}`);
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
