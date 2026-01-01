// scripts/arbitrage.js
// -------------------------
// Polygon Arbitrage Bot (Full ES Module, Inline Config)
// -------------------------

import { ethers } from "ethers";

// -------------------------
// CONFIG (inline, avoids missing module issues)
// -------------------------
export const tokens = {
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 }
};

export const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Vault contract
export const contractAddress = "0xYourVaultAddressHere"; // replace with real
export const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com"); // example RPC

export const contract = new ethers.Contract(
  contractAddress,
  [
    "function executeArbitrage(address,address,address,uint256) external",
    "function withdrawProfit(address) external",
    "function balanceOf(address) view returns (uint256)"
  ],
  provider.getSigner()
);

// -------------------------
// STATE
// -------------------------
let isScanning = false;
let accumulatedProfit = 0;
let transactionHistory = [];
let walletAddress = null; // set when connected

// -------------------------
// HELPERS
// -------------------------
function fmt(value, decimals = 6) {
  return Number(value).toFixed(decimals);
}

async function getContractUSDCBalance() {
  const usdc = new ethers.Contract(
    tokens.USDC.address,
    ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"],
    provider
  );
  const decimals = await usdc.decimals();
  const balance = await usdc.balanceOf(contractAddress);
  return Number(ethers.utils.formatUnits(balance, decimals));
}

async function updateBalances() {
  const vault = await getContractUSDCBalance();
  const wallet = await provider.getBalance(walletAddress);
  console.log(`🏦 Vault USDC: ${vault.toFixed(6)}\n👛 Wallet MATIC: ${ethers.utils.formatEther(wallet)}\n`);
}

// -------------------------
// PRICE / AMOUNT CALCULATION
// -------------------------
async function getAmountOut(router, tokenAddress, amountIn) {
  // mock function; replace with real on-chain call
  // return value in token units (not USDC)
  return amountIn / 1; // identity for example
}

// -------------------------
// LOGGING
// -------------------------
function log(msg) {
  console.log(msg);
}

function logTransaction(txDetails) {
  const time = new Date().toLocaleTimeString();
  const profit = txDetails.actualProfit || '';
  console.log(`${time} | ${txDetails.symbol} | BUY ${txDetails.buyDex} | SELL ${txDetails.sellDex} | NET PROFIT: ${profit}`);
  transactionHistory.push(txDetails);
}

// -------------------------
// ARBITRAGE SCAN + EXECUTION
// -------------------------
async function scanAndArbitrage() {
  if (!walletAddress) { log("Please set walletAddress"); return; }
  if (isScanning) return;

  isScanning = true;
  const tradeAmount = 1.0; // USDC for example
  const minProfit = 0.01; // USDC
  const amountIn = ethers.utils.parseUnits(tradeAmount.toString(), 6);

  log("🔍 Starting arbitrage scan...");

  for (const [symbol, meta] of Object.entries(tokens)) {
    const token = meta.address;
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, amountIn);
          const sellOut = await getAmountOut(sellRouter, token, amountIn);

          const buyPrice = tradeAmount / Number(ethers.utils.formatUnits(buyOut, meta.decimals));
          const sellPrice = tradeAmount / Number(ethers.utils.formatUnits(sellOut, meta.decimals));

          const profitUSDC = sellPrice - buyPrice;
          const profitPct = (profitUSDC / buyPrice) * 100;

          log(`📈 ${buyName} price: ${fmt(buyPrice)} USDC/${symbol}`);
          log(`📉 ${sellName} price: ${fmt(sellPrice)} USDC/${symbol}`);
          log(`💵 Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct, 2)}%)`);

          if (profitUSDC >= minProfit) {
            log("✅ MIN PROFIT satisfied — executing arbitrage...");
            await executeTrade(buyRouter, sellRouter, token, amountIn, symbol, profitPct);
          } else {
            log("❌ Below minimum profit — skipping");
          }
        } catch (err) {
          log(`⚠️ Error ${buyName} -> ${sellName}: ${err.message}`);
        }
      }
    }
  }

  isScanning = false;
  await updateBalances();
}

// -------------------------
// EXECUTE TRADE
// -------------------------
async function executeTrade(buyRouter, sellRouter, token, amountIn, symbol, profitPct) {
  try {
    const vaultBefore = await getContractUSDCBalance();
    const tx = await contract.executeArbitrage(buyRouter, sellRouter, token, amountIn, { gasLimit: 1_000_000 });
    const receipt = await tx.wait();
    const vaultAfter = await getContractUSDCBalance();
    const profit = vaultAfter - vaultBefore;
    accumulatedProfit += profit > 0 ? profit : 0;

    const txDetails = {
      timestamp: Date.now(),
      txHash: receipt.transactionHash,
      symbol,
      profitBeforeFees: fmt(profitPct, 2) + '%',
      actualProfit: fmt(profit, 6) + ' USDC',
      contractBalanceAfter: fmt(vaultAfter, 6) + ' USDC',
      buyDex: Object.keys(routers).find(k => routers[k] === buyRouter) || buyRouter,
      sellDex: Object.keys(routers).find(k => routers[k] === sellRouter) || sellRouter
    };

    logTransaction(txDetails);
    log(`✅ Arbitrage done! Profit: ${fmt(profit, 6)} USDC`);
  } catch (err) {
    log(`⚠️ Arbitrage failed for ${symbol}: ${err.message}`);
  }
}

// -------------------------
// EXPORTS
// -------------------------
export {
  scanAndArbitrage,
  executeTrade,
  updateBalances
};

// -------------------------
// Example usage
// -------------------------
(async () => {
  walletAddress = "0xYourWalletAddressHere"; // set your wallet
  await scanAndArbitrage();
})();
