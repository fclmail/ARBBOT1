import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const DRY_RUN = true; // set false to actually trade
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = 10.05;
const PROFIT_PCT_THRESHOLD = 0.002; // 0.2%
const SLIPPAGE_PCT = 0.2; // 0.2% slippage
const LOOP_DELAY_MS = 5000;

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------------- ROUTERS ----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// ---------------- TOKENS (checksummed) ----------------
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1BFD67037B42Cf73acF2047067BD4F2C47D9bFD6", decimals: 8 },
  CRV:  { address: "0x172370d5CD63279fFA6d502Dab29171933a610AF", decimals: 18 }
};

// ---------------- VAULT ----------------
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)"
];
const vaultContract = DRY_RUN
  ? new ethers.Contract(VAULT_ADDRESS, vaultAbi, provider)
  : new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

const erc20Abi = ["function balanceOf(address) view returns(uint256)"];
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[])"];

// ---------------- HELPERS ----------------
function fmt(n, dec = 6) {
  return Number(n).toFixed(dec);
}

// Colored log for console
function logLine(msg, profitPct = null) {
  const t = new Date().toISOString();
  let line = `[${t}] ${msg}`;
  if (profitPct !== null) {
    if (profitPct >= PROFIT_PCT_THRESHOLD) line = `\x1b[32m${line}\x1b[0m`; // green
    else if (profitPct < 0) line = `\x1b[31m${line}\x1b[0m`; // red
  }
  console.log(line);
  try { fs.appendFileSync("arb.log", line + "\n"); } catch (e) {}
}

// Safe amountsOut with fallback path
async function safeGetAmountsOut(routerAddr, path, amountInUnits) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    return await router.getAmountsOut(amountInUnits, path);
  } catch (e) {
    // fallback via WETH if path fails
    if (path.length === 2 && path[0].toLowerCase() !== tokens.WETH.address.toLowerCase()) {
      try {
        const router = new ethers.Contract(routerAddr, routerAbi, provider);
        return await router.getAmountsOut(amountInUnits, [path[0], tokens.WETH.address, path[1]]);
      } catch {}
    }
    throw e;
  }
}

async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, tradeAmountUSDC) {
  const usdcAddr = await vaultContract.USDC();
  const amountInUnits = ethers.parseUnits(tradeAmountUSDC.toString(), 6);

  let buyAmounts;
  try {
    buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokenObj.address], amountInUnits);
  } catch {
    buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokens.WETH.address, tokenObj.address], amountInUnits);
  }

  const tokenAmountBn = buyAmounts[buyAmounts.length - 1];
  if (!tokenAmountBn || tokenAmountBn === 0n) return 0n;

  let sellAmounts;
  try {
    sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, usdcAddr], tokenAmountBn);
  } catch {
    sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, tokens.WETH.address, usdcAddr], tokenAmountBn);
  }

  const expectedUSDCOutBn = sellAmounts[sellAmounts.length - 1];
  const slippageMultiplier = BigInt(Math.floor((1 - SLIPPAGE_PCT/100) * 1_000_000));
  return (expectedUSDCOutBn * slippageMultiplier) / 1_000_000n;
}

// ---------------- MAIN LOOP ----------------
async function mainLoop() {
  const tokenList = [tokens.WETH, tokens.WBTC, tokens.CRV];

  while (true) {
    try {
      for (const tokenObj of tokenList) {
        const routerEntries = Object.entries(routers);
        for (const [buyName, buyAddr] of routerEntries) {
          for (const [sellName, sellAddr] of routerEntries) {
            if (buyAddr.toLowerCase() === sellAddr.toLowerCase()) continue;

            const minReturnUSDCbn = await computeMinReturnUSDC(buyAddr, sellAddr, tokenObj, TRADE_AMOUNT_USDC);
            const minReturnUSDC = Number(minReturnUSDCbn) / 1e6;
            const rawProfitUSDC = minReturnUSDC - TRADE_AMOUNT_USDC;
            const profitPct = rawProfitUSDC / TRADE_AMOUNT_USDC;

            logLine(`Scan: Token=${tokenObj.address}, Buy:${buyName} Sell:${sellName}, Trade=${TRADE_AMOUNT_USDC}, MinReturn=${fmt(minReturnUSDC)}, Profit=${fmt(rawProfitUSDC)} (${(profitPct*100).toFixed(3)}%)`, profitPct);

            // Execute if profit ≥ threshold
            if (rawProfitUSDC >= TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD) {
              logLine(`✅ Arb viable. Executing: Buy ${buyName}, Sell ${sellName}, Token ${tokenObj.address}, MinReturn=${fmt(minReturnUSDC)}`, profitPct);

              if (!DRY_RUN) {
                try {
                  const tx = await vaultContract.executeArbitrage(
                    buyAddr,
                    sellAddr,
                    tokenObj.address,
                    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6),
                    ethers.parseUnits(minReturnUSDC.toFixed(6).toString(), 6)
                  );
                  logLine(`TX sent: ${tx.hash}`);
                  const receipt = await tx.wait();
                  logLine(`TX mined: block ${receipt.blockNumber}, status ${receipt.status}`);
                } catch (e) {
                  logLine(`⚠️ Arb execution failed: ${e?.message ?? e}`);
                }
              }
            }
            await new Promise(r => setTimeout(r, 50));
          }
        }
      }
    } catch (err) {
      logLine(`⚠️ Error in mainLoop: ${err?.message ?? err}`);
    }
    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

// ---------------- START ----------------
mainLoop().catch(err => logLine(`Fatal error: ${err?.message ?? err}`));
