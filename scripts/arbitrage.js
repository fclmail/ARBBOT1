/* arb.js
   - HTML-style profit calc (price per 1 token)
   - TRADE_USDC = 0.05
   - DRY_RUN toggle (true/false)
   - callStatic safety
   - accurate decimal normalization and profit accounting
*/

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const DRY_RUN = true;             // <--- set false to go live
const LOOP_DELAY_MS = 5000;       // 5s loop
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // required if DRY_RUN=false
const TRADE_USDC = 0.05;          // USDC per arbitrage
const MIN_PROFIT_PCT = 0.2;       // require >= 0.2% to execute

if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY is required for live mode");

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------------- ROUTERS (UniswapV2-style) ----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// ---------------- TOKENS ----------------
// Keep token symbol, address, decimals for normalization
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", symbol: "WBTC", decimals: 8 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", symbol: "CRV",  decimals: 18 }
};

// ---------------- VAULT ----------------
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)"
];
// When live, instantiate with signer (wallet), else use provider-only contract
const vaultContract = (DRY_RUN) ? new ethers.Contract(VAULT_ADDRESS, vaultAbi, provider) : new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ---------------- ABIs ----------------
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[])"];
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ---------------- STATE ----------------
let cumulativeProfitEstimated = 0; // running estimated profit (USDC)
let cumulativeProfitReal = 0;      // running real profit (USDC) when DRY_RUN=false

// ---------------- UTIL HELPERS ----------------
function logLine(msg, profitPct = null) {
  const t = new Date().toISOString();
  if (profitPct !== null) {
    if (profitPct > 0) msg = `\x1b[32m${msg}\x1b[0m`; // green
    else if (profitPct < 0) msg = `\x1b[31m${msg}\x1b[0m`; // red
  }
  const line = `[${t}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync("arb.log", line + "\n"); } catch (e) { /* ignore */ }
}

// safe callAmountsOut (returns BigInt[])
async function getAmountsOutSafe(routerAddr, path, amountIn) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    return await router.getAmountsOut(amountIn, path);
  } catch (e) {
    // propagate error upward so caller can decide
    throw new Error(`getAmountsOut failed: ${e?.message ?? e}`);
  }
}

// get decimals for ERC20 (cached)
const decimalsCache = {};
async function getTokenDecimals(addr) {
  if (decimalsCache[addr]) return decimalsCache[addr];
  const token = new ethers.Contract(addr, erc20Abi, provider);
  const d = await token.decimals();
  decimalsCache[addr] = Number(d);
  return Number(d);
}

// format big-int amount using decimals -> number
function formatAmount(amountBn, decimals) {
  try {
    return Number(ethers.formatUnits(amountBn, decimals));
  } catch (e) {
    // fallback safe
    return Number(amountBn.toString()) / Math.pow(10, decimals);
  }
}

// parse number to BigInt units
function parseAmount(num, decimals) {
  return ethers.parseUnits(num.toString(), decimals);
}

// Get vault USDC address + decimals once
let USDC_ADDRESS = null;
let USDC_DECIMALS = 6;
async function ensureUSDCInfo() {
  if (!USDC_ADDRESS) {
    USDC_ADDRESS = await vaultContract.USDC();
    try { USDC_DECIMALS = await getTokenDecimals(USDC_ADDRESS); } catch (e) { USDC_DECIMALS = 6; }
  }
}

// Get vault USDC balance (number)
async function getVaultUSDCBalance() {
  await ensureUSDCInfo();
  const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, USDC_DECIMALS));
}

// compute buyPrice and sellPrice (USDC per 1 token) with normalization
async function getPrices(buyRouter, sellRouter, tokenObj) {
  await ensureUSDCInfo();
  const tokenDecimals = tokenObj.decimals;
  // amount = 1 token (raw)
  const oneTokenUnits = parseAmount("1", tokenDecimals);

  // buyPrice: USDC required to buy 1 token (getAmountsOut from USDC->token for 1 USDC doesn't work; we want USDC per token)
  // Use getAmountsOut with input = 1 token -> output in USDC by path [token, USDC]
  // But to get USDC per 1 token: call getAmountsOut(buyRouter, [USDC, token], amountIn = x USDC) to compute token output for x USDC,
  // easier approach: getAmountsOut(router, [token, USDC], oneTokenUnits) => USDC amount for 1 token => price
  let buyPriceUSDC, sellPriceUSDC;

  try {
    // Price on buy router: how many USDC do you get if you SELL 1 token on buy router? That gives USDC per token
    const buyAmounts = await getAmountsOutSafe(buyRouter, [tokenObj.address, USDC_ADDRESS], oneTokenUnits);
    buyPriceUSDC = formatAmount(buyAmounts[buyAmounts.length - 1], USDC_DECIMALS);
  } catch (e) {
    // fallback: try reverse path (USDC -> token) and compute invert; but only if previous fails
    try {
      const guess = await getAmountsOutSafe(buyRouter, [USDC_ADDRESS, tokenObj.address], parseAmount("1", USDC_DECIMALS));
      const tokensPer1USDC = formatAmount(guess[guess.length - 1], tokenDecimals);
      if (tokensPer1USDC === 0) buyPriceUSDC = 0;
      else buyPriceUSDC = 1.0 / tokensPer1USDC;
    } catch (e2) {
      buyPriceUSDC = 0;
    }
  }

  try {
    // Price on sell router: USDC per 1 token
    const sellAmounts = await getAmountsOutSafe(sellRouter, [tokenObj.address, USDC_ADDRESS], oneTokenUnits);
    sellPriceUSDC = formatAmount(sellAmounts[sellAmounts.length - 1], USDC_DECIMALS);
  } catch (e) {
    try {
      const guess = await getAmountsOutSafe(sellRouter, [USDC_ADDRESS, tokenObj.address], parseAmount("1", USDC_DECIMALS));
      const tokensPer1USDC = formatAmount(guess[guess.length - 1], tokenDecimals);
      if (tokensPer1USDC === 0) sellPriceUSDC = 0;
      else sellPriceUSDC = 1.0 / tokensPer1USDC;
    } catch (e2) {
      sellPriceUSDC = 0;
    }
  }

  return { buyPriceUSDC, sellPriceUSDC };
}

// estimate net profit (USDC) based on TRADE_USDC and price difference (HTML-style)
function estimateNetProfit_USDC(tradeUSDC, buyPrice, sellPrice) {
  if (!buyPrice || buyPrice === 0) return 0;
  const profitPct = (sellPrice - buyPrice) / buyPrice;
  const net = tradeUSDC * profitPct;
  return net;
}

// Execute arbitrage via vault; amountInUSDC is BigInt with USDC_DECIMALS
async function doExecuteArbitrage(buyRouter, sellRouter, tokenObj, amountInUSDC_BN) {
  // callStatic simulation first (uses same signature)
  try {
    // callStatic will throw if it would revert; if it returns undefined it's fine
    await vaultContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenObj.address,
      amountInUSDC_BN,
      0
    );
  } catch (e) {
    // simulation failed
    throw new Error(`callStatic simulation failed: ${e?.message ?? e}`);
  }

  // If DRY_RUN, do not send tx
  if (DRY_RUN) {
    return { success: true, txHash: null };
  }

  // live: measure vault USDC before/after
  const usdcBefore = await getVaultUSDCBalance();

  // send tx
  const tx = await vaultContract.executeArbitrage(
    buyRouter,
    sellRouter,
    tokenObj.address,
    amountInUSDC_BN,
    0,
    { gasLimit: 1000000 }
  );
  logLine(`TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  const usdcAfter = await getVaultUSDCBalance();
  const profitReal = usdcAfter - usdcBefore;
  return { success: true, txHash: tx.hash, receipt, profitReal };
}

// ---------------- MAIN LOOP ----------------
async function mainLoop() {
  await ensureUSDCInfo();
  logLine(`Starting arb scanner. DRY_RUN=${DRY_RUN}, TRADE_USDC=${TRADE_USDC}`);

  // Pre-parse amountInUSDC BigInt for calls (USDC decimals)
  const amountInUSDC_BN = ethers.parseUnits(TRADE_USDC.toString(), USDC_DECIMALS);

  const tokenList = Object.values(tokens);

  while (true) {
    for (const tokenObj of tokenList) {
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyRouter.toLowerCase() === sellRouter.toLowerCase()) continue;

          try {
            // 1) Get normalized prices (USDC per 1 token)
            const { buyPriceUSDC, sellPriceUSDC } = await getPrices(buyRouter, sellRouter, tokenObj);

            // guard against invalid prices
            if (!buyPriceUSDC || buyPriceUSDC === 0 || !Number.isFinite(buyPriceUSDC)) {
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | Invalid buyPrice: ${String(buyPriceUSDC)}`);
              continue;
            }
            if (!sellPriceUSDC || !Number.isFinite(sellPriceUSDC)) {
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | Invalid sellPrice: ${String(sellPriceUSDC)}`);
              continue;
            }

            // 2) Compute profit % (HTML-style relative to price per 1 token)
            const profitPct = ((sellPriceUSDC - buyPriceUSDC) / buyPriceUSDC) * 100;

            // 3) Estimate net profit for TRADE_USDC
            const netProfitEstimated = estimateNetProfit_USDC(TRADE_USDC, buyPriceUSDC, sellPriceUSDC);

            // 4) Logging colorized and detailed
            const shortMsg = `Token=${tokenObj.symbol} | Buy:${buyName} | Sell:${sellName} | BuyPrice:${buyPriceUSDC.toFixed(6)} | SellPrice:${sellPriceUSDC.toFixed(6)} | ProfitPct:${profitPct.toFixed(3)}% | NetProfit💰:${netProfitEstimated.toFixed(6)}`;

            // If profitable over threshold, attempt execution
            if (profitPct >= MIN_PROFIT_PCT) {
              if (DRY_RUN) {
                cumulativeProfitEstimated += netProfitEstimated;
                logLine(`DRY RUN: Would execute → ${shortMsg} | CumProfitEst💰💰:${cumulativeProfitEstimated.toFixed(6)}`, profitPct);
              } else {
                // Live mode: call doExecuteArbitrage with amountInUSDC_BN
                try {
                  // Real pre-check: simulate with callStatic inside doExecuteArbitrage
                  const res = await doExecuteArbitrage(buyRouter, sellRouter, tokenObj, amountInUSDC_BN);
                  if (res && res.success) {
                    // If profitReal available, use it; else use estimate
                    let profitReal = 0;
                    if (res.hasOwnProperty("profitReal") && typeof res.profitReal === "number") {
                      profitReal = res.profitReal;
                      cumulativeProfitReal += profitReal;
                    } else {
                      // fallback: use estimated profit
                      profitReal = netProfitEstimated;
                      cumulativeProfitReal += profitReal;
                    }
                    logLine(`${shortMsg} | TX:${res.txHash} | NetReal💰:${profitReal.toFixed(6)} | CumProfitReal💰💰:${cumulativeProfitReal.toFixed(6)}`, profitPct);
                  } else {
                    logLine(`Execution aborted (no result): ${shortMsg}`, profitPct);
                  }
                } catch (e) {
                  logLine(`⚠️ Execution failed for ${tokenObj.symbol} ${buyName}->${sellName}: ${e.message}`, null);
                }
              }
            } else {
              // Not profitable enough
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | ProfitPct:${profitPct.toFixed(3)}% | EstNet💰:${netProfitEstimated.toFixed(6)}`, profitPct);
            }

          } catch (err) {
            logLine(`⚠️ Error scanning ${tokenObj.symbol} ${buyName}->${sellName}: ${err?.message ?? err}`, null);
          }

        } // sellRouter loop
      } // buyRouter loop
    } // tokens loop

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

// ---------------- START ----------------
mainLoop().catch(err => {
  logLine(`Fatal error: ${err?.message ?? err}`, null);
  process.exit(1);
});
