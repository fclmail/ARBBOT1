import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const DRY_RUN = true; // set false for live trades
const LOOP_DELAY_MS = 5000; // 5s
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // required if DRY_RUN=false

if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY is required for live mode");

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------------- ROUTERS ----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// ---------------- TOKENS ----------------
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", symbol: "WBTC", decimals: 8 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", symbol: "CRV", decimals: 18 }
};

// ---------------- VAULT ----------------
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19"; // your vault contract
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)"
];
const vaultContract = DRY_RUN 
  ? new ethers.Contract(VAULT_ADDRESS, vaultAbi, provider)
  : new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ---------------- ABIs ----------------
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[])"];
const erc20Abi = ["function balanceOf(address) view returns(uint256)"];

// ---------------- HELPERS ----------------
function logLine(msg, profitPct = null) {
  const t = new Date().toISOString();
  if (profitPct !== null) {
    if (profitPct > 0) msg = `\x1b[32m${msg}\x1b[0m`; // green
    else if (profitPct < 0) msg = `\x1b[31m${msg}\x1b[0m`; // red
  }
  console.log(`[${t}] ${msg}`);
  try { fs.appendFileSync("arb.log", `[${t}] ${msg}\n`); } catch {}
}

async function getAmountsOut(routerAddr, path, amountIn) {
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  return await router.getAmountsOut(amountIn, path);
}

// Execute arbitrage function
async function executeArbitrage(buyRouter, sellRouter, tokenObj, amountTokens, minReturnUSDC) {
  if (DRY_RUN) {
    logLine(`DRY RUN: Would execute arbitrage: ${tokenObj.symbol} Buy:${buyRouter} Sell:${sellRouter} Amount:${amountTokens}`);
    return;
  }

  try {
    const tx = await vaultContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenObj.address,
      amountTokens,
      minReturnUSDC
    );
    logLine(`TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    logLine(`TX mined: block ${receipt.blockNumber}, status ${receipt.status}`);
  } catch (e) {
    logLine(`⚠️ Arb execution failed: ${e?.message ?? e}`);
  }
}

// ---------------- MAIN LOOP ----------------
async function mainLoop() {
  const tokenList = Object.values(tokens);

  while (true) {
    for (const tokenObj of tokenList) {
      const routerEntries = Object.entries(routers);

      for (const [buyName, buyAddr] of routerEntries) {
        for (const [sellName, sellAddr] of routerEntries) {
          if (buyAddr.toLowerCase() === sellAddr.toLowerCase()) continue;

          try {
            // Simulate buying 1 token
            const amountIn = ethers.parseUnits("1", tokenObj.decimals);

            // Buy price (1 token)
            const buyAmounts = await getAmountsOut(buyAddr, [tokens.WETH.address, tokenObj.address], amountIn).catch(() => [amountIn, amountIn]);
            const buyPrice = Number(ethers.formatUnits(buyAmounts[buyAmounts.length - 1], tokenObj.decimals));

            // Sell price (1 token)
            const sellAmounts = await getAmountsOut(sellAddr, [tokenObj.address, tokens.WETH.address], amountIn).catch(() => [amountIn, amountIn]);
            const sellPrice = Number(ethers.formatUnits(sellAmounts[sellAmounts.length - 1], tokenObj.decimals));

            // Profit per token (HTML-style)
            const profitPct = ((sellPrice - buyPrice) / buyPrice) * 100;

            logLine(`Token=${tokenObj.symbol} | Buy:${buyName} | Sell:${sellName} | BuyPrice:${buyPrice.toFixed(6)} | SellPrice:${sellPrice.toFixed(6)} | ProfitPct:${profitPct.toFixed(3)}%`, profitPct);

            // Only execute if profitPct > 0.2%
            if (profitPct >= 0.2) {
              // Vault expects minReturnUSDC; we can just pass 0 for simplicity in HTML-style simulation
              await executeArbitrage(buyAddr, sellAddr, tokenObj, amountIn, 0);
            }

          } catch (e) {
            logLine(`⚠️ Error ${tokenObj.symbol} ${buyName}->${sellName}: ${e.message}`);
          }
        }
      }
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

// ---------------- START ----------------
mainLoop().catch(err => logLine(`Fatal error: ${err.message}`));
