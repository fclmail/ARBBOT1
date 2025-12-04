/**
 * 🔥 Fixed Production Arbitrage Bot 🔥
 * - DRY_RUN = false (LIVE TRADING ENABLED)
 * - Trade Amount: 0.05 USDC
 * - Vault Balance will only increase on profitable trades
 */

import { ethers, Wallet } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false;
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// Hardcoded vault contract address
const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trade settings
const TRADE_AMOUNT_USDC = 0.05; // 0.05 USDC per trade
const MIN_EXPECTED_PROFIT_USDC = 0.001; // min profit threshold
const SLIPPAGE_PCT = 0.3; // slippage allowance %

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Tokens
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 }
};

// Vault contract ABI
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];

const vaultContract = DRY_RUN
  ? new ethers.Contract(VAULT_ADDRESS, vaultAbi, provider)
  : new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ERC20 ABI
const erc20Abi = ["function balanceOf(address owner) view returns(uint256)"];

// ---------- Helpers ----------
async function getUSDCBalance() {
  const usdcAddress = await vaultContract.USDC();
  const usdc = new ethers.Contract(usdcAddress, erc20Abi, provider);
  return await usdc.balanceOf(VAULT_ADDRESS);
}

async function getAmountsOut(routerAddr, path, amountInUnits) {
  if (path[0].toLowerCase() === path[path.length - 1].toLowerCase()) {
    // Avoid IDENTICAL_ADDRESSES revert
    return [amountInUnits, amountInUnits];
  }
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  return await router.getAmountsOut(amountInUnits, path);
}

async function computeMinReturn(buyRouter, sellRouter, tokenObj, amountUSDC) {
  const usdcAddress = await vaultContract.USDC();
  const amountInUnits = ethers.parseUnits(amountUSDC.toString(), 6);
  const buyAmounts = await getAmountsOut(buyRouter, [usdcAddress, tokenObj.address], amountInUnits);
  const tokenAmount = buyAmounts[buyAmounts.length - 1];
  const sellAmounts = await getAmountsOut(sellRouter, [tokenObj.address, usdcAddress], tokenAmount);
  const expectedUSDCOut = Number(ethers.formatUnits(sellAmounts[sellAmounts.length - 1], 6));
  const safetyMultiplier = 1 - SLIPPAGE_PCT / 100 - 0.0025;
  return ethers.parseUnits((expectedUSDCOut * safetyMultiplier).toFixed(6), 6);
}

// Execute trade only if profitable
async function executeTrade(buyRouter, sellRouter, tokenObj, amountUSDC) {
  const vaultBalanceBefore = await getUSDCBalance();
  const minReturnBN = await computeMinReturn(buyRouter, sellRouter, tokenObj, amountUSDC);

  const amountInBN = ethers.parseUnits(amountUSDC.toString(), 6);
  if (minReturnBN.lte(amountInBN)) {
    console.log(`⚠️ Skipping unprofitable trade for ${tokenObj.address}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`🧪 DRY_RUN: would trade ${amountUSDC} USDC on ${tokenObj.address}`);
    return;
  }

  const tx = await vaultContract.executeArbitrage(buyRouter, sellRouter, tokenObj.address, amountInBN, minReturnBN);
  console.log(`🚀 Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status === 1) {
    const vaultBalanceAfter = await getUSDCBalance();
    console.log(`✅ Trade completed. Profit: ${Number(ethers.formatUnits(vaultBalanceAfter.sub(vaultBalanceBefore),6)).toFixed(6)} USDC`);
  } else {
    console.log("❌ Trade failed");
  }
}

// ---------- Scan Loop ----------
async function scanOnce() {
  const usdcBalance = Number(ethers.formatUnits(await getUSDCBalance(), 6));
  if (usdcBalance < TRADE_AMOUNT_USDC) {
    console.log(`⚠️ Vault balance too low: ${usdcBalance} USDC`);
    return;
  }

  for (const [symbol, tokenObj] of Object.entries(tokens)) {
    if (symbol === "USDC") continue; // skip USDC -> USDC
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyRouter === sellRouter) continue; // avoid identical addresses
        try {
          await executeTrade(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC);
        } catch (e) {
          console.warn("⚠️ Trade failed:", e.message.split("\n")[0]);
        }
      }
    }
  }
}

// ---------- Main Loop ----------
(async () => {
  const owner = await vaultContract.owner();
  const usdcAddress = await vaultContract.USDC();
  console.log("🏛 Vault:", VAULT_ADDRESS);
  console.log("👤 Owner:", owner);
  console.log("💱 USDC:", usdcAddress);
  console.log("🚀 Arbitrage bot started (LIVE)");

  while (true) {
    await scanOnce();
    await new Promise(r => setTimeout(r, 5000));
  }
})();
