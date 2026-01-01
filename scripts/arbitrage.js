// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const RPC_URL = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

// Tokens
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6
const WETH = "0x172370d5cd63279efa6d502dab29171933a610af"; // 18

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = ethers.parseUnits("100", 6); // 100 USDC
const MIN_PROFIT_USDC = 0.001; // USDC
const SLIPPAGE_PCT = 15;

// -------------------- CONTRACTS --------------------
const quickRouter = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);

const VAULT_ABI = ["function depositProfit(uint256 amount) external"];
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const usdcContract = new ethers.Contract(USDC, ERC20_ABI, provider);

// -------------------- UTILS --------------------
async function getAmountsOut(router, amountIn, path) {
  try {
    return await router.getAmountsOut(amountIn, path);
  } catch (err) {
    console.error("getAmountsOut error:", err.message);
    return null;
  }
}

function computeProfit(tradeUSDC, wethOut, usdcBack, slippagePct) {
  const trade = Number(ethers.formatUnits(tradeUSDC, 6));
  const weth = Number(ethers.formatUnits(wethOut, 18));
  const usdc = Number(ethers.formatUnits(usdcBack, 6));

  // Correct prices
  const buyPrice = trade / weth;      // USDC per WETH
  const sellPrice = usdc / weth;      // USDC per WETH

  const grossProfit = usdc - trade;
  const adjustedProfit = grossProfit * (1 - slippagePct / 100);
  const priceDiffPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

  return { buyPrice, sellPrice, grossProfit, adjustedProfit, priceDiffPercent };
}

async function getVaultUSDCBalance() {
  const bal = await usdcContract.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function getWalletMaticBalance() {
  const bal = await provider.getBalance(wallet.address);
  return Number(ethers.formatUnits(bal, 18));
}

// -------------------- ARBITRAGE SCAN --------------------
async function scanArbitrage() {
  console.log(`\n⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);

  console.log(`🏦 Vault USDC: ${(await getVaultUSDCBalance()).toFixed(6)}`);
  console.log(`👛 Wallet MATIC: ${(await getWalletMaticBalance()).toFixed(6)}`);

  const pairs = [
    { buy: quickRouter, buyDEX: "QuickSwap", sell: sushiRouter, sellDEX: "SushiSwap" },
    { buy: sushiRouter, buyDEX: "SushiSwap", sell: quickRouter, sellDEX: "QuickSwap" }
  ];

  let executed = false;

  for (const p of pairs) {
    const buyAmounts = await getAmountsOut(p.buy, TRADE_AMOUNT_USDC, [USDC, WETH]);
    if (!buyAmounts) continue;

    const sellAmounts = await getAmountsOut(p.sell, buyAmounts[1], [WETH, USDC]);
    if (!sellAmounts) continue;

    const stats = computeProfit(
      TRADE_AMOUNT_USDC,
      buyAmounts[1],
      sellAmounts[1],
      SLIPPAGE_PCT
    );

    console.log(`🔍 ${p.buyDEX} ➜ ${p.sellDEX}`);
    console.log(`📈 Buy price: ${stats.buyPrice.toFixed(2)} USDC/WETH`);
    console.log(`📉 Sell price: ${stats.sellPrice.toFixed(2)} USDC/WETH`);
    console.log(`💵 Price diff: ${stats.priceDiffPercent.toFixed(3)} %`);
    console.log(`💵 Gross profit: ${stats.grossProfit.toFixed(6)} USDC`);
    console.log(`💵 Adjusted profit: ${stats.adjustedProfit.toFixed(6)} USDC`);

    if (stats.adjustedProfit >= MIN_PROFIT_USDC) {
      executed = true;
      console.log(`✅ MIN PROFIT satisfied — executing`);

      const profitUSDC6 = ethers.parseUnits(
        stats.adjustedProfit.toFixed(6),
        6
      );

      try {
        const tx = await vaultContract.depositProfit(profitUSDC6);
        console.log(`📤 Tx hash: ${tx.hash}`);
        await tx.wait();
        console.log(`💰 Vault after: ${(await getVaultUSDCBalance()).toFixed(6)}`);
      } catch (e) {
        console.error("⚠️ Execution failed:", e.message);
      }
    } else {
      console.log("❌ Below minimum profit");
    }
  }

  if (!executed) console.log("⚠️ No executable arbitrage this cycle");
}

// -------------------- LOOP --------------------
async function startLoop() {
  while (true) {
    await scanArbitrage();
    await new Promise(r => setTimeout(r, 3000));
  }
}

startLoop();
