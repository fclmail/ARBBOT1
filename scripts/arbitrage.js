// arb.js — Live-ready arbitrage bot
// FEATURES
// - Uses provided vault ABI + contract address
// - USDC fixed to 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (Polygon)
// - TRADE_USDC = 0.05
// - DRY_RUN toggle (default false = LIVE)
// - callStatic pre-flight safety
// - Accurate decimal normalization
// - Uses getAmountsOut for token->USDC price per 1 token
// - Executes vault.executeArbitrage(...) when profitable (>= MIN_PROFIT_PCT)
// - Uses provider feeData (EIP-1559) when possible
// - Decodes ArbitrageExecuted event from receipt
// - Logs estimated & real net profit and cumulative totals
//
// WARNING: This file WILL send real transactions if DRY_RUN = false and PRIVATE_KEY is set.
// Make sure you understand the financial risks and have funds available.

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // REQUIRED if DRY_RUN=false
let DRY_RUN = false; // <--- set to false for live execution (you asked LIVE)
const LOOP_DELAY_MS = 5000; // 5s loop
const TRADE_USDC = 0.05; // USDC per arbitrage (0.05)
const MIN_PROFIT_PCT = 0.2; // 0.2% threshold (relative to price per 1 token)
const VERBOSE = true; // set false to quiet logs

if (!DRY_RUN && !PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY is required for live mode (DRY_RUN=false)");
}

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
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", symbol: "CRV",  decimals: 18 }
};

// ---------------- VAULT & ABI (provided) ----------------
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ABI = [
  {
    "inputs":[{"internalType":"address","name":"_usdc","type":"address"},{"internalType":"uint256","name":"_minProfitUSDC","type":"uint256"}],
    "stateMutability":"nonpayable","type":"constructor"
  },
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"executor","type":"address"},{"indexed":true,"internalType":"address","name":"buyRouter","type":"address"},{"indexed":true,"internalType":"address","name":"sellRouter","type":"address"},{"indexed":false,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountIn","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"beforeUSDC","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"afterUSDC","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"profitUSDC","type":"uint256"}],"name":"ArbitrageExecuted","type":"event"},
  {"inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountInUSDC","type":"uint256"},{"internalType":"uint256","name":"minReturnUSDC","type":"uint256"}],"name":"executeArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"newMinProfit","type":"uint256"}],"name":"MinProfitUpdated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"bool","name":"isPaused","type":"bool"}],"name":"Paused","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"Rescue","type":"event"},
  {"inputs":[{"internalType":"address","name":"token","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"rescueToken","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"_minProfitUSDC","type":"uint256"}],"name":"setMinProfit","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bool","name":"_p","type":"bool"}],"name":"setPaused","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"minProfitUSDC","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"paused","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"USDC","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"}
];

// instantiate vault contract with provider or signer
const vaultContract = DRY_RUN ? new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider) : new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ---------------- ABIs ----------------
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[])"];
const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

// ---------------- USDC (explicit) ----------------
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // polygon USDC
const USDC_DECIMALS = 6;

// ---------------- STATE ----------------
let cumulativeProfitEstimated = 0; // USDC estimated
let cumulativeProfitReal = 0;      // USDC real (vault balance delta)

// ---------------- LOGGING HELPERS ----------------
function logLine(msg, profitPct = null) {
  const t = new Date().toISOString();
  if (profitPct !== null) {
    if (profitPct > 0) msg = `\x1b[32m${msg}\x1b[0m`; // green for profit
    else if (profitPct < 0) msg = `\x1b[31m${msg}\x1b[0m`; // red for negative
  }
  const line = `[${t}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync("arb.log", line + "\n"); } catch (e) { /* ignore */ }
}

// ---------------- UTIL HELPERS ----------------

// parse decimal-normalized BigInt for token decimals
function parseAmountToBN(amountStrOrNum, decimals) {
  return ethers.parseUnits(amountStrOrNum.toString(), decimals);
}
function formatBN(amountBn, decimals) {
  return Number(ethers.formatUnits(amountBn, decimals));
}

// safe getAmountsOut (propagate errors)
async function getAmountsOutSafe(routerAddr, path, amountInBn) {
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  return await router.getAmountsOut(amountInBn, path);
}

// get token decimals (use provided table or fall back to on-chain)
const tokenDecimalsCache = {};
async function getTokenDecimals(addr, fallback) {
  if (tokenDecimalsCache[addr]) return tokenDecimalsCache[addr];
  try {
    const t = new ethers.Contract(addr, erc20Abi, provider);
    const d = Number(await t.decimals());
    tokenDecimalsCache[addr] = d;
    return d;
  } catch {
    tokenDecimalsCache[addr] = fallback ?? 18;
    return tokenDecimalsCache[addr];
  }
}

// get vault USDC balance (number)
async function getVaultUSDCBalanceNumber() {
  const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, USDC_DECIMALS));
}

// compute prices: USDC per 1 token (normalized numbers)
async function getPrices_USDCperToken(buyRouter, sellRouter, tokenObj) {
  const tokenDecimals = tokenObj.decimals;
  const oneTokenBN = parseAmountToBN("1", tokenDecimals);

  let buyPrice = 0;
  let sellPrice = 0;

  // For buyPrice: amount of USDC you'd get if you SOLD 1 token on the buyRouter (token -> USDC)
  try {
    const buyOut = await getAmountsOutSafe(buyRouter, [tokenObj.address, USDC_ADDRESS], oneTokenBN);
    const usdcOutBn = buyOut[buyOut.length - 1];
    buyPrice = formatBN(usdcOutBn, USDC_DECIMALS);
  } catch (e) {
    // fallback attempt: invert USDC -> token quote for 1 USDC and compute 1/(tokens per USDC)
    try {
      const guess = await getAmountsOutSafe(buyRouter, [USDC_ADDRESS, tokenObj.address], parseAmountToBN("1", USDC_DECIMALS));
      const tokensPer1USDC = formatBN(guess[guess.length - 1], tokenDecimals);
      buyPrice = tokensPer1USDC === 0 ? 0 : (1 / tokensPer1USDC);
    } catch {
      buyPrice = 0;
    }
  }

  // For sellPrice: amount of USDC you'd get if you SOLD 1 token on the sellRouter (token -> USDC)
  try {
    const sellOut = await getAmountsOutSafe(sellRouter, [tokenObj.address, USDC_ADDRESS], oneTokenBN);
    const usdcOutBn = sellOut[sellOut.length - 1];
    sellPrice = formatBN(usdcOutBn, USDC_DECIMALS);
  } catch (e) {
    try {
      const guess = await getAmountsOutSafe(sellRouter, [USDC_ADDRESS, tokenObj.address], parseAmountToBN("1", USDC_DECIMALS));
      const tokensPer1USDC = formatBN(guess[guess.length - 1], tokenDecimals);
      sellPrice = tokensPer1USDC === 0 ? 0 : (1 / tokensPer1USDC);
    } catch {
      sellPrice = 0;
    }
  }

  return { buyPrice, sellPrice };
}

// estimate net profit in USDC (HTML-style): tradeUSDC * (sellPrice - buyPrice) / buyPrice
function estimateNetProfitUSDC(tradeUSDC, buyPrice, sellPrice) {
  if (!buyPrice || buyPrice === 0) return 0;
  const profitPct = (sellPrice - buyPrice) / buyPrice;
  return tradeUSDC * profitPct;
}

// do callStatic + send tx; returns object with txHash/receipt/profitReal (if calculated)
async function executeOnVault(buyRouter, sellRouter, tokenObj, amountInUSDC_BN, minReturnUSDC_BN) {
  // 1) callStatic (simulate)
  try {
    // callStatic will throw if execution would revert
    await vaultContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenObj.address,
      amountInUSDC_BN,
      minReturnUSDC_BN
    );
  } catch (e) {
    throw new Error(`callStatic simulation failed: ${e?.message ?? e}`);
  }

  // 2) measure vault USDC before
  const before = await getVaultUSDCBalanceNumber();

  // 3) build gas options (prefer EIP-1559 fee data)
  let txOptions = { gasLimit: 1_200_000 }; // upper bound, adjust if needed
  try {
    const feeData = await provider.getFeeData();
    // feeData.maxFeePerGas and maxPriorityFeePerGas may be null on some providers
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      txOptions.maxFeePerGas = feeData.maxFeePerGas;
      txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else if (feeData.gasPrice) {
      txOptions.gasPrice = feeData.gasPrice;
    }
  } catch (e) {
    // ignore fee suggestion errors
  }

  // 4) send tx (live)
  const tx = await vaultContract.executeArbitrage(
    buyRouter,
    sellRouter,
    tokenObj.address,
    amountInUSDC_BN,
    minReturnUSDC_BN,
    txOptions
  );
  logLine(`TX sent: ${tx.hash}`);
  const receipt = await tx.wait();

  // 5) measure vault USDC after
  const after = await getVaultUSDCBalanceNumber();

  // 6) try to decode ArbitrageExecuted event from receipt logs (optional)
  let eventDecoded = null;
  try {
    for (const log of receipt.logs) {
      try {
        const parsed = vaultContract.interface.parseLog(log);
        if (parsed && parsed.name === "ArbitrageExecuted") {
          eventDecoded = {
            executor: parsed.args.executor,
            buyRouter: parsed.args.buyRouter,
            sellRouter: parsed.args.sellRouter,
            token: parsed.args.token,
            amountIn: parsed.args.amountIn.toString(),
            beforeUSDC: Number(ethers.formatUnits(parsed.args.beforeUSDC, USDC_DECIMALS)),
            afterUSDC: Number(ethers.formatUnits(parsed.args.afterUSDC, USDC_DECIMALS)),
            profitUSDC: Number(ethers.formatUnits(parsed.args.profitUSDC, USDC_DECIMALS))
          };
          break;
        }
      } catch {
        // parse may throw for logs that aren't our event; ignore
      }
    }
  } catch {
    eventDecoded = null;
  }

  const profitReal = after - before;
  return { txHash: tx.hash, receipt, before, after, profitReal, eventDecoded };
}

// ---------------- MAIN LOOP ----------------
async function mainLoop() {
  logLine(`Starting arb scanner. DRY_RUN=${DRY_RUN}, TRADE_USDC=${TRADE_USDC}, MIN_PROFIT_PCT=${MIN_PROFIT_PCT}%`);

  const amountInUSDC_BN = parseAmountToBN(TRADE_USDC.toString(), USDC_DECIMALS);
  const minReturnUSDC_BN = 0n; // we use 0 for minReturn here (vault may require non-zero in production)

  // token objects array
  const tokenList = Object.values(tokens);

  while (true) {
    for (const tokenObj of tokenList) {
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyRouter.toLowerCase() === sellRouter.toLowerCase()) continue;

          try {
            // 1) compute buy/sell price (USDC per 1 token)
            const { buyPrice, sellPrice } = await getPrices_USDCperToken(buyRouter, sellRouter, tokenObj);

            // validate numbers
            if (!Number.isFinite(buyPrice) || buyPrice === 0) {
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | Invalid buyPrice: ${String(buyPrice)}`);
              continue;
            }
            if (!Number.isFinite(sellPrice) || sellPrice === 0) {
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | Invalid sellPrice: ${String(sellPrice)}`);
              continue;
            }

            // 2) compute profit pct (HTML-style relative to price per 1 token)
            const profitPct = ((sellPrice - buyPrice) / buyPrice) * 100;

            // 3) estimate net profit for TRADE_USDC
            const netEst = estimateNetProfitUSDC(TRADE_USDC, buyPrice, sellPrice);

            // short log message
            const msgShort = `Token=${tokenObj.symbol} | Buy:${buyName} | Sell:${sellName} | BuyPrice:${buyPrice.toFixed(6)} | SellPrice:${sellPrice.toFixed(6)} | ProfitPct:${profitPct.toFixed(3)}% | EstNet💰:${netEst.toFixed(6)}`;

            // 4) take decision
            if (profitPct >= MIN_PROFIT_PCT) {
              // candidate
              if (DRY_RUN) {
                cumulativeProfitEstimated += netEst;
                logLine(`DRY RUN: WOULD EXECUTE → ${msgShort} | CumEst💰💰:${cumulativeProfitEstimated.toFixed(6)}`, profitPct);
              } else {
                // live attempt (callStatic inside executeOnVault)
                try {
                  const res = await executeOnVault(buyRouter, sellRouter, tokenObj, amountInUSDC_BN, minReturnUSDC_BN);
                  // prefer event-decoded profit if available
                  let profitReal = 0;
                  if (res.eventDecoded && typeof res.eventDecoded.profitUSDC === "number") {
                    profitReal = res.eventDecoded.profitUSDC;
                  } else {
                    profitReal = res.profitReal;
                  }
                  cumulativeProfitReal += profitReal;
                  logLine(`${msgShort} | TX:${res.txHash} | NetReal💰:${profitReal.toFixed(6)} | CumProfitReal💰💰:${cumulativeProfitReal.toFixed(6)}`, profitPct);
                } catch (execErr) {
                  logLine(`⚠️ Execution failed for ${tokenObj.symbol} ${buyName}->${sellName}: ${execErr?.message ?? execErr}`, null);
                }
              }
            } else {
              // skip
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | ProfitPct:${profitPct.toFixed(3)}% | EstNet💰:${netEst.toFixed(6)}`, profitPct);
            }

          } catch (e) {
            logLine(`⚠️ Error scanning ${tokenObj.symbol} ${buyName}->${sellName}: ${e?.message ?? e}`, null);
          }
        }
      }
    }

    // loop delay
    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

// ---------------- START ----------------
mainLoop().catch(err => {
  logLine(`Fatal error: ${err?.message ?? err}`, null);
  process.exit(1);
});
