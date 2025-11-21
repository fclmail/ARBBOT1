// scripts/arb.js
import { ethers } from "ethers";

// ===== CONFIGURATION =====
const PROVIDER_URL = "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";

const DEX_ROUTERS = {
  quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Trade settings
const TRADE_AMOUNTS_USDC = [0.001, 0.01, 10, 1000, 100000, 1000000];
const MIN_PROFIT_USDC = 0.0001;
const SCAN_INTERVAL_MS = 30000; // 30 seconds between scans

// ===== ABIs =====
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function callStaticExecuteArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) view returns (uint256)",
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
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);
const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);

// ===== TOKENS TO SCAN =====
const tokens = {
  CRV: { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF" },
  MATIC: { address: "0x0000000000000000000000000000000000001010" },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" }
};

// ===== UTILITY FUNCTIONS =====
async function getAmountOut(routerAddress, token, amountInUSDC) {
  try {
    const path = [USDC_ADDRESS, token.address];
    const amountInWei = ethers.parseUnits(amountInUSDC.toString(), 6);
    const amounts = await new ethers.Contract(routerAddress, routerAbi, provider).getAmountsOut(amountInWei, path);
    const tokenDecimals = await new ethers.Contract(token.address, erc20Abi, provider).decimals();
    return Number(ethers.formatUnits(amounts[1], tokenDecimals));
  } catch {
    return 0; // Fail-safe: return 0 on error
  }
}

async function getVaultBalance() {
  return Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
}

function fmt(num, dec = 6) {
  return Number(num).toFixed(dec);
}

// ===== MAIN LOOP =====
async function main() {
  console.log("🚀 LIVE MODE ENABLED — FULL FAILSAFE CHECKS");
  console.log("🏛 Contract Address:", VAULT_ADDRESS);

  const owner = await vault.owner();
  console.log("👤 Owner:", owner);

  let vaultBalance = await getVaultBalance();
  console.log("🏦 Vault Before:", fmt(vaultBalance), "USDC\n");

  while (true) {
    console.log("🔍 Scanning for arbitrage opportunities...\n");

    for (const [symbol, token] of Object.entries(tokens)) {
      const dexPairs = Object.entries(DEX_ROUTERS);

      for (const [buyName, buyRouter] of dexPairs) {
        for (const [sellName, sellRouter] of dexPairs) {
          if (buyName === sellName) continue;

          for (const amount of TRADE_AMOUNTS_USDC) {
            try {
              const buyOut = await getAmountOut(buyRouter, token, amount);
              const sellOut = await getAmountOut(sellRouter, token, amount);

              if (!buyOut || !sellOut) continue; // Fail-safe

              const buyPrice = amount / buyOut;
              const sellPrice = amount / sellOut;
              const rawProfit = (sellPrice - buyPrice) * amount;

              if (!isFinite(rawProfit) || rawProfit < MIN_PROFIT_USDC) continue;

              console.log(`${symbol} | buy:${buyName} $${fmt(buyPrice)} → sell:${sellName} $${fmt(sellPrice)} | amount: ${amount} | rawProfit: ${fmt(rawProfit)} USDC`);

              console.log("💰 PROFITABLE — checking callStatic...");
              try {
                const expected = await vault.callStatic.executeArbitrage(
                  buyRouter,
                  sellRouter,
                  token.address,
                  ethers.parseUnits(amount.toString(), 6)
                );
                if (Number(ethers.formatUnits(expected, 6)) <= 0) {
                  console.log("❌ callStatic blocked trade — SAFE\n");
                  continue;
                }
              } catch {
                console.log("❌ callStatic failed — SAFE\n");
                continue;
              }

              // Execute trade
              console.log(`🚀 Executing arbitrage: approx +${fmt(rawProfit)} USDC`);
              const tx = await vault.executeArbitrage(
                buyRouter,
                sellRouter,
                token.address,
                ethers.parseUnits(amount.toString(), 6),
                { gasLimit: 900_000 }
              );
              await tx.wait();

              const newVaultBalance = await getVaultBalance();
              const netProfit = newVaultBalance - vaultBalance;
              if (netProfit > 0) {
                console.log(`🏦 Vault increased by ${fmt(netProfit)} USDC\n`);
                vaultBalance = newVaultBalance;
              } else {
                console.log("❌ Vault loss prevented — trade reverted or no profit\n");
              }

            } catch (err) {
              console.log(`⚠ Error scanning ${symbol} ${buyName}->${sellName} for amount ${amount}:`, err.message);
            }
          }
        }
      }
    }

    console.log(`🔁 Scan complete — next scan in ${SCAN_INTERVAL_MS / 1000}s\n`);
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

// ===== START =====
main().catch(console.error);
