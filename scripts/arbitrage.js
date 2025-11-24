// improved-arbitrage.js (DRY RUN ENABLED VERSION) // Only change: DRY_RUN is forced to true. Everything else unchanged.

import { ethers, Wallet } from "ethers"; import fs from "fs"; import dotenv from "dotenv"; dotenv.config();

// ---------- CONFIG ---------- // Force dry run always ON const DRY_RUN = true;

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com/"; const PRIVATE_KEY = process.env.PRIVATE_KEY; const VAULT_CONTRACT = process.env.VAULT_CONTRACT; const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.5); const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.20); const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.10); const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.003); const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.50); const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);

// Routers const ROUTERS = { sushi: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", quick: "0xa5e0829caecd0c0aa76d551d8e5f7f3d77a91fd3", firebird: "0xf3a9f0b736b3e7f5ce437d7b8da89f219f0adc55" };

// Tokens const TOKENS = { USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6, minProfit: 0.002 }, WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, minProfit: 0.002 }, WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, minProfit: 0.002 } };

// Setup const provider = new ethers.JsonRpcProvider(RPC_URL); const wallet = new Wallet(PRIVATE_KEY, provider);

// Vault ABI const vaultAbi = [ "function recordProfit(uint256 amount) external", "function getVaultBalance() external view returns (uint256)" ]; const vault = new ethers.Contract(VAULT_CONTRACT, vaultAbi, wallet);

// Utility: Logger function log(msg) { console.log(msg); }

// Utility: Format function fmt(v, dec = 4) { return Number(v).toFixed(dec); }

// Load router function routerContract(addr) { return new ethers.Contract( addr, ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"], provider ); }

// Price fetch async function getPrice(routerAddr, tokenIn, tokenOut, amountIn) { try { const router = routerContract(routerAddr); const path = [tokenIn.address, tokenOut.address]; const amt = ethers.parseUnits(amountIn.toString(), tokenIn.decimals); const out = await router.getAmountsOut(amt, path); return Number(ethers.formatUnits(out[1], tokenOut.decimals)); } catch (e) { return null; } }

// Gas est async function estimateGasUSD() { try { const gas = await provider.estimateGas({ from: wallet.address, to: wallet.address, value: 0 }); const gasPrice = await provider.getGasPrice(); const maticPrice = 0.75; return Number(ethers.formatUnits(gas * gasPrice, 18)) * maticPrice; } catch (e) { return 0.10; } }

// Main arbitrage checker async function checkArb() { log("----------------------------------------"); log("🔍 Scanning for arbitrage opportunities...");

const tokenA = TOKENS.USDC; const tokenB = TOKENS.WETH; const amount = TRADE_AMOUNT_USDC;

for (const r1Name in ROUTERS) { for (const r2Name in ROUTERS) { if (r1Name === r2Name) continue;

const r1 = ROUTERS[r1Name];
  const r2 = ROUTERS[r2Name];

  const out1 = await getPrice(r1, tokenA, tokenB, amount);
  const out2 = await getPrice(r2, tokenB, tokenA, out1 || 0);

  if (!out1 || !out2) continue;

  const profit = out2 - amount;
  const pct = (profit / amount) * 100;
  const minNeed = Math.max(MIN_EXPECTED_PROFIT, tokenA.minProfit);

  log(`Routers: ${r1Name} → ${r2Name}`);
  log(`Expected return: ${fmt(out2)} USDC`);
  log(`Profit: ${fmt(profit)} (${fmt(pct)}%)`);

  if (profit < minNeed) {
    log("Not enough profit.");
    continue;
  }

  const gasUSD = await estimateGasUSD();
  log(`Gas est: $${fmt(gasUSD)}`);

  const net = profit - gasUSD;
  log(`Net profit after gas: $${fmt(net)}`);

  if (net <= 0) {
    log("Not profitable after gas.");
    continue;
  }

  // Dry run forced ON
  log("🚫 DRY RUN ENABLED — No transaction sent.");
  return;
}

} }

// Loop async function main() { while (true) { await checkArb(); log(Waiting ${SCAN_INTERVAL_MS / 1000}s...); await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS)); } }

main();
