// scripts/arbitrage.js
import { ethers } from "ethers";

// ===== CONFIGURATION =====
const PROVIDER_URL = "https://polygon-rpc.com"; // your RPC
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY; // load from env for safety
const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // example on Polygon
const DEX_ROUTERS = {
  quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};
const MIN_NET_PROFIT_USDC = 0.01; // minimum profit threshold
const SCAN_INTERVAL_MS = 30_000; // 30 seconds

// ===== ABIs =====
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function owner() view returns (address)",
  "function USDC() view returns (address)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) returns (uint[] memory)"
];

// ===== PROVIDER & WALLET =====
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ===== CONTRACT INSTANCES =====
const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);
const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);

// ===== UTILITY FUNCTIONS =====
async function getTokenDecimals(tokenAddress) {
  const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return await token.decimals();
}

async function getVaultBalance() {
  return Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
}

function logTradeResult(scanNum, buyDex, sellDex, tokenSymbol, rawProfit, netProfit, executed, reason) {
  console.log(`\n🔎 DEX Scan #${scanNum}`);
  console.log(`${tokenSymbol} | ${buyDex} → ${sellDex}`);
  if (executed) {
    console.log(`Raw Profit: ${rawProfit.toFixed(6)} USDC`);
    console.log(`Net Profit: ${netProfit.toFixed(6)} USDC`);
    console.log(`💸 Trade EXECUTED ✅`);
  } else {
    console.log(`Raw Profit: ${rawProfit.toFixed(6)} USDC`);
    console.log(`❌ Rejected — ${reason}`);
  }
}

// ===== MAIN ARBITRAGE LOGIC =====
async function scanAndTrade() {
  try {
    console.log("🚀 LIVE MODE ENABLED — FULL FAILSAFE CHECKS");
    console.log("🏛 Contract Address:", VAULT_ADDRESS);

    const owner = await vaultContract.owner();
    console.log("👤 Owner:", owner);

    let vaultBalance = await getVaultBalance();
    console.log("🏦 Vault Before:", vaultBalance.toFixed(6), "USDC");

    // Token list to scan
    const tokenList = [
      { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF" },
      { symbol: "MATIC", address: "0x0000000000000000000000000000000000001010" },
      { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" }
    ];

    let scanNum = 0;

    for (const token of tokenList) {
      scanNum++;

      const dexPairs = [
        ["quickswap", "sushiswap"],
        ["quickswap", "apeswap"],
        ["sushiswap", "quickswap"]
      ];

      for (const [buyDexKey, sellDexKey] of dexPairs) {
        const buyRouter = DEX_ROUTERS[buyDexKey];
        const sellRouter = DEX_ROUTERS[sellDexKey];
        const tokenDecimals = await getTokenDecimals(token.address);

        const amountIn = ethers.parseUnits(".01", 6); // 10 USDC

        try {
          const buyPath = [USDC_ADDRESS, token.address];
          const sellPath = [token.address, USDC_ADDRESS];

          const buyAmounts = await new ethers.Contract(buyRouter, routerAbi, provider).getAmountsOut(amountIn, buyPath);
          const sellAmounts = await new ethers.Contract(sellRouter, routerAbi, provider).getAmountsOut(buyAmounts[1], sellPath);

          const rawProfit = Number(ethers.formatUnits(sellAmounts[1] - amountIn, 6));

          if (rawProfit < MIN_NET_PROFIT_USDC) {
            logTradeResult(scanNum, buyDexKey, sellDexKey, token.symbol, rawProfit, 0, false, "below minimum net profit threshold");
            continue;
          }

          // callStatic pre-check
          try {
            await vaultContract.callStatic.executeArbitrage(buyRouter, sellRouter, token.address, amountIn);
          } catch (err) {
            logTradeResult(scanNum, buyDexKey, sellDexKey, token.symbol, rawProfit, 0, false, "callStatic failed (expected revert)");
            continue;
          }

          // Execute trade
          const tx = await vaultContract.executeArbitrage(buyRouter, sellRouter, token.address, amountIn);
          await tx.wait();

          const newVaultBalance = await getVaultBalance();
          const netProfit = newVaultBalance - vaultBalance;

          if (netProfit <= 0) {
            console.log(`❌ Vault loss prevented — transaction reverted or no profit`);
          } else {
            logTradeResult(scanNum, buyDexKey, sellDexKey, token.symbol, rawProfit, netProfit, true);
            vaultBalance = newVaultBalance;
            console.log("🏦 Vault After:", vaultBalance.toFixed(6), "USDC");
          }

        } catch (err) {
          console.log(`⚠ Scan #${scanNum} failed due to error:`, err.message);
        }
      }
    }

    console.log("\n🔁 Loop complete — waiting 30s for next scan...\n");

  } catch (err) {
    console.error("Fatal error during scan:", err);
  }
}

// ===== START CONTINUOUS LOOP =====
scanAndTrade(); // run first time immediately
setInterval(scanAndTrade, SCAN_INTERVAL_MS); // then repeat every 30 seconds
