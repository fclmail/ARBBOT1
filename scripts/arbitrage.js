import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// -------------------------
// CONFIG
// -------------------------
const DRY_RUN = false; // true = simulate, false = live
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = 10; // USDC per arbitrage
const PROFIT_PCT_THRESHOLD = 0.002; // 0.2%
const SLIPPAGE_PCT = 0.2; // 0.2% slippage
const LOOP_DELAY_MS = 5000;

// -------------------------
// PROVIDER & WALLET
// -------------------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// -------------------------
// ROUTERS
// -------------------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// -------------------------
// TOKENS (checksummed)
// -------------------------
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1BFD67037B42Cf73acF2047067BD4F2C47D9BfD6", decimals: 8 },
  CRV:  { address: "0x172370d5CD63279fFA6d502Dab29171933a610AF", decimals: 18 }
};

// -------------------------
// VAULT CONTRACT
// -------------------------
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];
const vaultContract = DRY_RUN
  ? new ethers.Contract(VAULT_ADDRESS, vaultAbi, provider)
  : new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ERC20 and Router ABI
const erc20Abi = ["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"];
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[])"];

// -------------------------
// HELPERS
// -------------------------
function fmt(n, d = 6) { return Number(n).toFixed(d); }

// Colorized console output
function logColor(msg, type = "info") {
  const t = new Date().toISOString();
  let color;
  switch (type) {
    case "profit": color = "\x1b[32m"; break; // green
    case "loss": color = "\x1b[31m"; break;   // red
    case "warn": color = "\x1b[33m"; break;   // yellow
    default: color = "\x1b[0m";               // reset
  }
  console.log(`${color}[${t}] ${msg}\x1b[0m`);
  try { fs.appendFileSync("arb.log", `[${t}] ${msg}\n`); } catch {}
}

async function safeGetAmountsOut(routerAddr, path, amountInUnits) {
  if (path.length >= 2 && path[0].toLowerCase() === path[path.length - 1].toLowerCase()) {
    return [amountInUnits, amountInUnits];
  }
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  return await router.getAmountsOut(amountInUnits, path);
}

async function computeArb(buyRouter, sellRouter, tokenObj, amountUSDCFloat) {
  const usdcAddr = await vaultContract.USDC();
  const amountInUnits = ethers.parseUnits(amountUSDCFloat.toString(), 6);

  // BUY
  let buyAmounts;
  try { buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokenObj.address], amountInUnits); }
  catch { buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokens.WBTC.address, tokenObj.address], amountInUnits); }

  const tokenAmount = buyAmounts[buyAmounts.length - 1];
  if (!tokenAmount || tokenAmount === 0n) return null;

  // SELL
  let sellAmounts;
  try { sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, usdcAddr], tokenAmount); }
  catch { sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, tokens.WBTC.address, usdcAddr], tokenAmount); }

  const expectedUSDCOut = sellAmounts[sellAmounts.length - 1];
  const slippageAdjusted = expectedUSDCOut * BigInt(Math.floor((1 - SLIPPAGE_PCT / 100) * 1_000_000)) / 1_000_000n;

  return {
    buyPrice: Number(amountInUnits) / Number(tokenAmount),
    sellPrice: Number(expectedUSDCOut) / Number(tokenAmount),
    minReturnUSDC: Number(slippageAdjusted) / 1e6
  };
}

// -------------------------
// MAIN LOOP
// -------------------------
async function mainLoop() {
  const tokenList = [tokens.WETH, tokens.WBTC, tokens.CRV];

  while (true) {
    try {
      for (const tokenObj of tokenList) {
        for (const [buyName, buyAddr] of Object.entries(routers)) {
          for (const [sellName, sellAddr] of Object.entries(routers)) {
            if (buyAddr.toLowerCase() === sellAddr.toLowerCase()) continue;

            const result = await computeArb(buyAddr, sellAddr, tokenObj, TRADE_AMOUNT_USDC);
            if (!result) {
              logColor(`Error computing ${tokenObj.address} on ${buyName} -> ${sellName}`, "warn");
              continue;
            }

            const profitUSDC = result.minReturnUSDC - TRADE_AMOUNT_USDC;
            const profitPct = profitUSDC / TRADE_AMOUNT_USDC;

            const logType = profitUSDC >= TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD ? "profit" : "loss";
            logColor(
              `Scan: ${tokenObj.address} Buy:${buyName} Sell:${sellName} ` +
              `BuyPrice:${fmt(result.buyPrice, 6)} SellPrice:${fmt(result.sellPrice, 6)} ` +
              `ProfitUSDC:${fmt(profitUSDC, 6)} ProfitPct:${(profitPct * 100).toFixed(3)}%`,
              logType
            );

            if (profitUSDC >= TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD) {
              logColor(`🚨 Arb viable! Executing trade for ${tokenObj.address}`, "profit");
              if (DRY_RUN) {
                logColor(`DRY RUN: would execute arbitrage with minReturnUSDC=${fmt(result.minReturnUSDC, 6)}`, "warn");
              } else {
                try {
                  const tx = await vaultContract.executeArbitrage(
                    buyAddr,
                    sellAddr,
                    tokenObj.address,
                    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6),
                    ethers.parseUnits(result.minReturnUSDC.toFixed(6).toString(), 6)
                  );
                  logColor(`TX sent: ${tx.hash}`, "profit");
                  const receipt = await tx.wait();
                  logColor(`TX mined: block ${receipt.blockNumber}, status ${receipt.status}`, "profit");
                } catch (e) {
                  logColor(`Arb execution failed: ${e?.message ?? e}`, "warn");
                }
              }
            }

            await new Promise(r => setTimeout(r, 50));
          }
        }
      }
    } catch (err) {
      logColor(`Error in mainLoop: ${err?.message ?? err}`, "warn");
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

// -------------------------
// START
// -------------------------
mainLoop().catch(err => {
  logColor(`Fatal error: ${err?.message ?? err}`, "warn");
});
