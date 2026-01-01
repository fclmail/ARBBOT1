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
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"; // 18 decimals

// Hardcoded vault address
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = ethers.parseUnits("1000", 6); // 1000 USDC
const MIN_PROFIT_USDC = 0.01;

// -------------------- CONTRACTS --------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);

// Vault interface (minimal)
const VAULT_ABI = [
  "function depositProfit(uint amount) external"
];
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

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

function computeProfit(buyAmount, sellAmount) {
  const gross = Number(ethers.formatUnits(sellAmount, 6)) - Number(ethers.formatUnits(buyAmount, 6));
  const adjusted = gross * 0.85; // Assume fees/slippage 15%
  return { gross, adjusted };
}

// -------------------- ARBITRAGE --------------------
async function scanArbitrage() {
  console.log(`⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);

  // Define DEX pairs
  const pairs = [
    { buyRouter: quickRouter, buyDEX: "QuickSwap", sellRouter: sushiRouter, sellDEX: "SushiSwap" },
    { buyRouter: sushiRouter, buyDEX: "SushiSwap", sellRouter: quickRouter, sellDEX: "QuickSwap" }
  ];

  let anyOpportunity = false;

  for (const pair of pairs) {
    const path = [USDC, WETH];
    const reversePath = [WETH, USDC];

    // Get buy amount (USDC -> WETH)
    const buyAmounts = await getAmountsOut(pair.buyRouter, TRADE_AMOUNT_USDC, path);
    if (!buyAmounts) continue;
    const wethOut = buyAmounts[1];

    // Get sell amount (WETH -> USDC)
    const sellAmounts = await getAmountsOut(pair.sellRouter, wethOut, reversePath);
    if (!sellAmounts) continue;
    const usdcBack = sellAmounts[1];

    const buyPrice = Number(ethers.formatUnits(TRADE_AMOUNT_USDC, 6)) / Number(ethers.formatUnits(wethOut, 18));
    const sellPrice = Number(ethers.formatUnits(usdcBack, 6)) / Number(ethers.formatUnits(wethOut, 18));

    const priceDiffPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

    const { gross, adjusted } = computeProfit(TRADE_AMOUNT_USDC, usdcBack);

    // Logs
    console.log(`🔍 ${pair.buyDEX} ➜ ${pair.sellDEX}`);
    console.log(`📈 ${pair.buyDEX} price: ${buyPrice.toFixed(6)} USDC/WETH`);
    console.log(`📉 ${pair.sellDEX} price: ${sellPrice.toFixed(6)} USDC/WETH`);
    console.log(`💵 Price-ratio diff: ${priceDiffPercent.toFixed(3)} %`);
    console.log(`💵 Gross profit: ${gross.toFixed(6)} USDC`);
    console.log(`💵 Adjusted profit: ${adjusted.toFixed(6)} USDC`);

    if (adjusted >= MIN_PROFIT_USDC) {
      anyOpportunity = true;
      console.log(`✅ MIN PROFIT = ${MIN_PROFIT_USDC} USDC satisfied`);
      console.log(`🚀 Executing arbitrage...`);

      const vaultBalanceBefore = await provider.getBalance(VAULT_ADDRESS);
      console.log(`💰 Vault USDC before: ${ethers.formatUnits(vaultBalanceBefore, 6)}`);

      // Execute arbitrage: For demonstration, we just simulate deposit
      const tx = await vaultContract.depositProfit(usdcBack);
      console.log(`📤 Tx hash: ${tx.hash}`);
      await tx.wait();

      const vaultBalanceAfter = await provider.getBalance(VAULT_ADDRESS);
      console.log(`💰 Vault USDC after: ${ethers.formatUnits(vaultBalanceAfter, 6)}`);
    } else {
      console.log(`❌ Below minimum profit – not executing`);
    }
  }

  if (!anyOpportunity) console.log(`⚠️ No executable arbitrage this cycle`);
}

// -------------------- MAIN --------------------
(async () => {
  try {
    await scanArbitrage();
  } catch (err) {
    console.error("Error in arbitrage scan:", err);
  }
})();
