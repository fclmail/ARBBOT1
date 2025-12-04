/**
 * arb.js — Ethers v6 compatible, live-ready arbitrage scanner + executor
 *
 * Usage:
 *  - put PRIVATE_KEY and optional RPC_URL in .env
 *  - npm install ethers
 *  - node arb.js
 *
 * NOTE: This file defaults to DRY_RUN = false (LIVE). Set DRY_RUN = true to simulate.
 */

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // required if DRY_RUN=false
let DRY_RUN = false; // set true to simulate
const LOOP_DELAY_MS = 5000; // 5s
const TRADE_USDC = 0.05; // USDC per arbitrage
const MIN_PROFIT_PCT = 0.2; // 0.2%
const VERBOSE = true; // set false to reduce logs

if (!DRY_RUN && !PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY required when DRY_RUN=false");
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
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", symbol: "CRV", decimals: 18 }
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

// vault contract instantiated with signer when live
const vaultContract = DRY_RUN ? new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider) : new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ---------------- ABIs ----------------
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[])"];
const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

// ---------------- USDC ----------------
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS = 6;

// ---------------- STATE ----------------
let cumulativeProfitEstimated = 0;
let cumulativeProfitReal = 0;

// ---------------- LOGGING ----------------
function logLine(msg, profitPct = null) {
  const t = new Date().toISOString();
  if (profitPct !== null) {
    if (profitPct > 0) msg = `\x1b[32m${msg}\x1b[0m`;
    else if (profitPct < 0) msg = `\x1b[31m${msg}\x1b[0m`;
  }
  const line = `[${t}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync("arb.log", line + "\n"); } catch {}
}

// ---------------- HELPERS ----------------
function parseBN(amount, decimals) {
  return ethers.parseUnits(amount.toString(), decimals);
}
function formatBN(amountBn, decimals) {
  return Number(ethers.formatUnits(amountBn, decimals));
}

async function getAmountsOutSafe(routerAddr, path, amountBn) {
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  return await router.getAmountsOut(amountBn, path);
}

async function getVaultUSDCBalance() {
  const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, USDC_DECIMALS));
}

async function getPrices_USDCperToken(buyRouter, sellRouter, tokenObj) {
  const tokenDecimals = tokenObj.decimals;
  const oneTokenBN = parseBN("1", tokenDecimals);

  let buyPrice = 0;
  let sellPrice = 0;

  try {
    const buyOut = await getAmountsOutSafe(buyRouter, [tokenObj.address, USDC_ADDRESS], oneTokenBN);
    buyPrice = formatBN(buyOut[buyOut.length - 1], USDC_DECIMALS);
  } catch {
    try {
      const guess = await getAmountsOutSafe(buyRouter, [USDC_ADDRESS, tokenObj.address], parseBN("1", USDC_DECIMALS));
      const tokensPer1USDC = formatBN(guess[guess.length - 1], tokenDecimals);
      buyPrice = tokensPer1USDC === 0 ? 0 : (1 / tokensPer1USDC);
    } catch {
      buyPrice = 0;
    }
  }

  try {
    const sellOut = await getAmountsOutSafe(sellRouter, [tokenObj.address, USDC_ADDRESS], oneTokenBN);
    sellPrice = formatBN(sellOut[sellOut.length - 1], USDC_DECIMALS);
  } catch {
    try {
      const guess = await getAmountsOutSafe(sellRouter, [USDC_ADDRESS, tokenObj.address], parseBN("1", USDC_DECIMALS));
      const tokensPer1USDC = formatBN(guess[guess.length - 1], tokenDecimals);
      sellPrice = tokensPer1USDC === 0 ? 0 : (1 / tokensPer1USDC);
    } catch {
      sellPrice = 0;
    }
  }

  return { buyPrice, sellPrice };
}

function estimateNetProfit(tradeUSDC, buyPrice, sellPrice) {
  if (!buyPrice || buyPrice === 0) return 0;
  const profitPct = (sellPrice - buyPrice) / buyPrice;
  return tradeUSDC * profitPct;
}

// Uses ethers v6 simulation: vaultContract.simulate.executeArbitrage(...)
async function simulateAndExecute(buyRouter, sellRouter, tokenObj, amountInUSDC_BN, minReturnUSDC_BN) {
  // Simulate (ethers v6)
  if (!vaultContract.simulate || typeof vaultContract.simulate.executeArbitrage !== "function") {
    throw new Error("vaultContract.simulate.executeArbitrage is not available — check ethers version");
  }

  // 1) simulate
  try {
    await vaultContract.simulate.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenObj.address,
      amountInUSDC_BN,
      minReturnUSDC_BN
    );
  } catch (e) {
    throw new Error(`simulation failed: ${e?.message ?? e}`);
  }

  // 2) before balance
  const before = await getVaultUSDCBalance();

  // 3) gas options
  let txOpts = { gasLimit: 1_200_000n };
  try {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      txOpts.maxFeePerGas = feeData.maxFeePerGas;
      txOpts.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else if (feeData.gasPrice) {
      txOpts.gasPrice = feeData.gasPrice;
    }
  } catch {}

  // 4) send
  const tx = await vaultContract.executeArbitrage(
    buyRouter,
    sellRouter,
    tokenObj.address,
    amountInUSDC_BN,
    minReturnUSDC_BN,
    txOpts
  );
  logLine(`TX sent: ${tx.hash}`);

  const receipt = await tx.wait();

  // 5) after balance
  const after = await getVaultUSDCBalance();

  // 6) try decode event
  let decodedEvent = null;
  try {
    for (const l of receipt.logs) {
      try {
        const parsed = vaultContract.interface.parseLog(l);
        if (parsed.name === "ArbitrageExecuted") {
          decodedEvent = {
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
        // ignore parse errors
      }
    }
  } catch {}

  const profitReal = after - before;
  return { txHash: tx.hash, receipt, before, after, profitReal, decodedEvent };
}

// ---------------- MAIN LOOP ----------------
async function mainLoop() {
  logLine(`Starting arb scanner. DRY_RUN=${DRY_RUN}, TRADE_USDC=${TRADE_USDC}, MIN_PROFIT_PCT=${MIN_PROFIT_PCT}%`);

  const amountInUSDC_BN = parseBN(TRADE_USDC.toString(), USDC_DECIMALS);
  const minReturnUSDC_BN = 0n; // for robust strategy compute this with slippage in production

  const tokenList = Object.values(tokens);

  while (true) {
    for (const tokenObj of tokenList) {
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyRouter.toLowerCase() === sellRouter.toLowerCase()) continue;

          try {
            const { buyPrice, sellPrice } = await getPrices_USDCperToken(buyRouter, sellRouter, tokenObj);

            if (!Number.isFinite(buyPrice) || buyPrice === 0) {
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | invalid buyPrice:${String(buyPrice)}`);
              continue;
            }
            if (!Number.isFinite(sellPrice) || sellPrice === 0) {
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | invalid sellPrice:${String(sellPrice)}`);
              continue;
            }

            const profitPct = ((sellPrice - buyPrice) / buyPrice) * 100;
            const netEst = estimateNetProfit(TRADE_USDC, buyPrice, sellPrice);

            const short = `Token=${tokenObj.symbol} | Buy:${buyName} | Sell:${sellName} | BuyPrice:${buyPrice.toFixed(6)} | SellPrice:${sellPrice.toFixed(6)} | ProfitPct:${profitPct.toFixed(3)}% | EstNet💰:${netEst.toFixed(6)}`;

            if (profitPct >= MIN_PROFIT_PCT) {
              if (DRY_RUN) {
                cumulativeProfitEstimated += netEst;
                logLine(`DRY RUN WOULD EXECUTE → ${short} | CumEst💰💰:${cumulativeProfitEstimated.toFixed(6)}`, profitPct);
              } else {
                try {
                  const res = await simulateAndExecute(buyRouter, sellRouter, tokenObj, amountInUSDC_BN, minReturnUSDC_BN);
                  const profitReal = (res.decodedEvent && typeof res.decodedEvent.profitUSDC === "number") ? res.decodedEvent.profitUSDC : res.profitReal;
                  cumulativeProfitReal += profitReal;
                  logLine(`${short} | TX:${res.txHash} | NetReal💰:${profitReal.toFixed(6)} | CumReal💰💰:${cumulativeProfitReal.toFixed(6)}`, profitPct);
                } catch (ex) {
                  logLine(`⚠️ Execution failed for ${tokenObj.symbol} ${buyName}->${sellName}: ${ex?.message ?? ex}`, null);
                }
              }
            } else {
              logLine(`Skipped ${tokenObj.symbol} ${buyName}->${sellName} | ProfitPct:${profitPct.toFixed(3)}% | EstNet💰:${netEst.toFixed(6)}`, profitPct);
            }
          } catch (err) {
            logLine(`⚠️ Error scanning ${tokenObj.symbol} ${buyName}->${sellName}: ${err?.message ?? err}`, null);
          }
        }
      }
    }

    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

// ---------------- START ----------------
mainLoop().catch(err => {
  logLine(`Fatal: ${err?.message ?? err}`, null);
  process.exit(1);
});
