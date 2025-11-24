// arbitrage-hardcoded-vault.js // Full arbitrage script with hard-coded VAULT contract address. // - Ethers v6 // - DRY_RUN default = true (safe). Set DRY_RUN=false in env to enable live mode. // - Failsafes: MIN_PROFIT_PCT, MIN_TRADE_USDC, SLIPPAGE_PCT, MIN_EXPECTED_PROFIT, gas estimate // - 30s scanner loop // - CSV logging

import { ethers, Wallet } from "ethers"; import fs from "fs"; import dotenv from "dotenv"; dotenv.config();

// ---------- CONFIG ---------- // DRY_RUN: if env variable DRY_RUN is set to "false" (string) the script will run live. // Default is true to avoid accidental live execution. const DRY_RUN = typeof process.env.DRY_RUN !== 'undefined' ? (process.env.DRY_RUN === 'true') : true; console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com"; const PRIVATE_KEY = process.env.PRIVATE_KEY || ""; // required for live mode if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// ---------- HARDCODED VAULT CONTRACT ---------- const VAULT_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Safety parameters (tunable via env) const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.5); // percent const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.20); const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.10); // percent const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.003); // USDC const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.50); const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000); const DEFAULT_EST_GAS_LIMIT = Number(process.env.DEFAULT_EST_GAS_LIMIT || 200000);

// Routers, tokens (same as your repo layout) const routers = { QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", ApeSwap:  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" };

const tokens = { AAVE: { symbol: 'AAVE', address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18, minProfit: 0.004 }, CRV:  { symbol: 'CRV',  address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18, minProfit: 0.003 }, LINK: { symbol: 'LINK', address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18, minProfit: 0.003 }, WBTC: { symbol: 'WBTC', address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8, minProfit: 0.006 } };

// CSV logging const csvRows = []; function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, gasUSDC }) { csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, gasUSDC].join(",")); } function saveCSV() { if (csvRows.length === 0) return; const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","GasUSDC"]; const filename = arbitrage_log_${Date.now()}.csv; fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n")); console.log(💾 CSV exported: ${filename}); }

// ---------- PROVIDER + WALLET ---------- const provider = new ethers.JsonRpcProvider(RPC_URL); const wallet = PRIVATE_KEY ? new Wallet(PRIVATE_KEY, provider) : null;

// ---------- VAULT CONTRACT ABI & Instance ---------- const arbAbi = [ { "inputs": [ { "internalType": "address", "name": "buyRouter", "type": "address" }, { "internalType": "address", "name": "sellRouter", "type": "address" }, { "internalType": "address", "name": "token", "type": "address" }, { "internalType": "uint256", "name": "amountIn", "type": "uint256" } ], "name": "executeArbitrage", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" } ];

const arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet || provider);

let usdcContract; const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() { try { const usdcAddr = await arbContract.USDC(); usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider); const owner = await arbContract.owner(); console.log("🏛 Contract Address:", VAULT_CONTRACT); console.log("👤 Contract Owner:", owner); } catch (e) { console.error("Failed to init vault contract:", e?.message || e); throw e; } }

// ---------- HELPERS ---------- function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountUSDC) { const router = new ethers.Contract( routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider ); const usdcAddress = await arbContract.USDC(); // try direct path, fallback via WBTC if needed const pathDirect = [usdcAddress, token.address]; try { const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), pathDirect); return Number(ethers.formatUnits(amounts[amounts.length-1], token.decimals)); } catch (err) { const fallback = [usdcAddress, tokens.WBTC.address, token.address]; const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), fallback); return Number(ethers.formatUnits(amounts[amounts.length-1], token.decimals)); } }

const WMATIC = process.env.WMATIC || "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; async function getMaticToUSDC(routerAddr, sampleAmount = '1') { try { const usdcAddr = await arbContract.USDC(); const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider); const amounts = await router.getAmountsOut(ethers.parseUnits(sampleAmount, 18), [WMATIC, usdcAddr]); return Number(ethers.formatUnits(amounts[amounts.length-1], 6)); } catch (e) { return null; } }

async function estimateGasCostUSDC(sampleRouter) { try { const feeData = await provider.getFeeData(); const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('1', 9); const gasLimit = DEFAULT_EST_GAS_LIMIT; let maticToUSDC = await getMaticToUSDC(sampleRouter); if (!maticToUSDC) maticToUSDC = 0.6; // conservative fallback const gasWei = gasPrice * BigInt(gasLimit); const gasMatic = Number(gasWei) / 1e18; const gasUSDC = gasMatic * maticToUSDC; return gasUSDC; } catch (e) { return 0.001; } }

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) { const timestamp = new Date().toISOString(); const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18, symbol: tokenAddr };

console.log("\n🔍 ---------- New Trade Attempt ----------"); console.log(🔹 ${timestamp} • Token: ${tokenObj.symbol || tokenAddr} • AmountIn: ${amountUSDC} USDC);

const beforeBal = await usdcContract.balanceOf(VAULT_CONTRACT); const before = Number(ethers.formatUnits(beforeBal, 6)); console.log(🏦 Vault Balance Before: ${fmt(before)} USDC);

if (amountUSDC < MIN_TRADE_USDC) { console.log(⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC); return; }

const gasUSDC = await estimateGasCostUSDC(buyRouter);

if (before < amountUSDC + gasUSDC) { console.log(⛔️ Skipping — Vault ${fmt(before)} < amount ${amountUSDC} + gas ${fmt(gasUSDC)}); return; }

let buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC); let sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);

const buyPrice  = amountUSDC / buyOut; const sellPrice = amountUSDC / sellOut; const rawProfit = (sellPrice - buyPrice); const expectedProfitUSDC = rawProfit * (1 - SLIPPAGE_PCT/100);

console.log(📈 Quoted: buy=${fmt(buyPrice)} sell=${fmt(sellPrice)} rawProfit=${fmt(rawProfit)} expected=${fmt(expectedProfitUSDC)});

const perTokenMin = tokenObj.minProfit || MIN_EXPECTED_PROFIT; const profitAfterGas = expectedProfitUSDC - gasUSDC; const profitPct = (rawProfit / buyPrice) * 100;

if (expectedProfitUSDC <= perTokenMin) { console.log(❌ PREVENTED — expectedProfit ${fmt(expectedProfitUSDC)} <= per-token min ${fmt(perTokenMin)}); return; }

if (profitAfterGas <= MIN_EXPECTED_PROFIT) { console.log(❌ PREVENTED — profit after gas ${fmt(profitAfterGas)} <= MIN_EXPECTED_PROFIT ${fmt(MIN_EXPECTED_PROFIT)}); return; }

if (profitPct < MIN_PROFIT_PCT) { console.log(❌ PREVENTED — profitPct ${fmt(profitPct)}% < MIN_PROFIT_PCT ${MIN_PROFIT_PCT}%); return; }

if (profitAfterGas <= 0) { console.log(❌ PREVENTED — profit after gas not positive: ${fmt(profitAfterGas)}); return; }

console.log("🚀 Executing arbitrage... (final checks passed)");

if (DRY_RUN) { console.log(🧪 DRY_RUN mode — simulation only, would call executeArbitrage(${buyRouter}, ${sellRouter}, ${tokenAddr}, ${amountUSDC})); logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: profitAfterGas, gasUSDC }); saveCSV(); return; }

if (!wallet) { console.error("No wallet available for live mode. Aborting."); return; }

try { const tx = await arbContract.connect(wallet).executeArbitrage( buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6), { gasLimit: DEFAULT_EST_GAS_LIMIT } );

console.log(`🔁 TX SENT — hash: ${tx.hash}`);
const receipt = await tx.wait();
if (!receipt || receipt.status === 0) {
  console.log("❌ Transaction reverted or failed");
  return;
}
console.log(`✅ Transaction success — gasUsed ${receipt.gasUsed?.toString()}`);

const afterBal = await usdcContract.balanceOf(VAULT_CONTRACT);
const after = Number(ethers.formatUnits(afterBal, 6));
console.log(`🏦 Vault Balance After: ${fmt(after)} USDC`);

const netProfit = after - before;
console.log(`💰 REAL Net Profit: ${fmt(netProfit)} USDC`);

if (netProfit <= 0) {
  console.error("🚨 WARNING — Net profit not positive after execution. Investigate immediately.");
}

logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, gasUSDC });
saveCSV();

} catch (err) { console.error("❌ Execution error:", err?.message || err); } }

// ---------- SCANNER ---------- async function scanOnce(tradeAmountUSDC = TRADE_AMOUNT_USDC) { const routerAddrs = Object.values(routers); const tokenList = Object.values(tokens); for (let i = 0; i < tokenList.length; i++) { for (let bi = 0; bi < routerAddrs.length; bi++) { for (let si = 0; si < routerAddrs.length; si++) { if (bi === si) continue; const buyRouter = routerAddrs[bi]; const sellRouter = routerAddrs[si]; try { await executeTradeLive(buyRouter, sellRouter, tokenList[i].address, tradeAmountUSDC); } catch (e) { console.error("scan error:", e?.message || e); } } } } }

// ---------- MAIN ---------- (async function main() { await init(); console.log(🚀 AUTO-SCAN ENABLED — scanning every ${SCAN_INTERVAL_MS/1000} seconds); await scanOnce(TRADE_AMOUNT_USDC); setInterval(async () => { try { await scanOnce(TRADE_AMOUNT_USDC); } catch (e) { console.error('loop error', e?.message || e); } }, SCAN_INTERVAL_MS); })();
