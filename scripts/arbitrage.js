// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – FULL RESTORED VERSION
//  - Calls on-chain vault.executeArbitrage(...) when profitable
//  - Logs real USDC vault balance BEFORE and AFTER each trade
//  - Restored tokens + routers
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not found in environment (GitHub Secrets).");

const DRY_RUN = false; // set true to simulate (no on-chain execute)
const MIN_TRADE_USDC = 0.01;        // minimum trade size (USDC)
const MIN_EXPECTED_PROFIT = 0.000001;  // minimum expected profit (USDC)
const MIN_PROFIT_PCT = .41;         // percent (e.g. 0.2% profit threshold)
const SLIPPAGE_PCT = 0.05;           // slippage tolerance applied to expectations
const MAX_PROFIT_PCT = 550;        // sanity cap for absurd quoted profit %

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmtNum = (n, dec = 6) => Number(n).toFixed(dec);

// ----------------- PROVIDER / WALLET / CONTRACT -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// Vault contract (ABI trimmed to needed functions)
const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const vaultAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }], "name": "withdrawProfit", "outputs": [], "stateMutability": "nonpayable", "type": "function" }
];

const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ERC20 ABI (very small)
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ----------------- TOKENS & ROUTERS (restored) -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// Routers (restored)
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Base fallback order for quoting (USDC -> USDT -> WETH -> WMATIC)
const BASE_FALLBACKS = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH (polygon wrapped)
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

// ----------------- HELPERS -----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGetAmountOut(routerAddr, tokenObj, amountUSDC) {
  try {
    let usdcAddr;
    try { usdcAddr = (await vaultContract.USDC()).toLowerCase(); } catch { usdcAddr = BASE_FALLBACKS[0].toLowerCase(); }
    const bases = [usdcAddr, ...BASE_FALLBACKS.map(b => b.toLowerCase()).filter(b => b !== usdcAddr)];

    const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);

    for (const base of bases) {
      try {
        const amounts = await router.getAmountsOut(amountInRaw, [base, tokenObj.address]);
        return Number(ethers.formatUnits(amounts[1], tokenObj.decimals));
      } catch (e) {
        continue;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function getVaultUsdcContract() {
  try {
    const usdcAddr = await vaultContract.USDC();
    return new ethers.Contract(usdcAddr, erc20Abi, provider);
  } catch (err) {
    return new ethers.Contract(BASE_FALLBACKS[0], erc20Abi, provider);
  }
}

async function getVaultBalanceHuman() {
  const usdc = await getVaultUsdcContract();
  const raw = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw, 6));
}

function saneProfitPct(pct) {
  if (!Number.isFinite(pct)) return false;
  if (pct < -1000 || pct > MAX_PROFIT_PCT) return false;
  return true;
}

// ----------------- CORE: executeTradeLive -----------------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };
  try {
    const usdcContract = await getVaultUsdcContract();

    const before = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
    console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

    // --- LOG WALLET BALANCE BEFORE TX ---
    const walletBalBefore = await provider.getBalance(wallet.address);
    console.log(`${colors.magenta}⛽ Wallet Balance Before: ${ethers.formatEther(walletBalBefore)} MATIC${colors.reset}`);

    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`${colors.yellow}⚠️ amount below MIN_TRADE_USDC, skipping${colors.reset}`);
      return;
    }

    const buyOut = await safeGetAmountOut(buyRouter, tokenObj, amountUSDC);
    const sellOut = await safeGetAmountOut(sellRouter, tokenObj, amountUSDC);
    if (buyOut === null || sellOut === null) {
      console.log(`${colors.yellow}⚠️ Quote missing on one side, skipping${colors.reset}`);
      return;
    }

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    let expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const expectedProfitPct = (expectedProfitUSDC / buyPrice) * 100;

    if (!saneProfitPct(expectedProfitPct)) {
      console.log(`${colors.yellow}⚠️ Crazy profit pct (${expectedProfitPct}), skipping${colors.reset}`);
      return;
    }

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT || expectedProfitPct < MIN_PROFIT_PCT) {
      console.log(`${colors.yellow}⚠️ Skipping trade — expected profit too low (${fmtNum(expectedProfitUSDC)} USDC / ${fmtNum(expectedProfitPct)}%)${colors.reset}`);
      return;
    }

    console.log(`${expectedProfitUSDC > 0 ? colors.green : colors.red}${tokenAddr} | Expected Profit: ${fmtNum(expectedProfitUSDC)} USDC | pct=${fmtNum(expectedProfitPct)}%${colors.reset}`);

    if (DRY_RUN) {
      console.log(`${colors.magenta}🔎 DRY RUN — not sending tx${colors.reset}`);
      return;
    }

    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
    let tx;
    try {
      tx = await vaultContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInRaw);
    } catch (err) {
      console.log(`${colors.red}⚠️ tx send error: ${err?.message || err}${colors.reset}`);
      return;
    }

    console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait();

    if (!receipt || receipt.status === 0) {
      console.log(`${colors.red}❌ TX failed${colors.reset}`);
      return;
    }

    // --- GAS LOG: receipt-based ---
    const gasUsed = receipt.gasUsed;
    const gasPrice = receipt.effectiveGasPrice;
    const gasFeeWei = gasUsed * gasPrice;
    const gasFeeNative = ethers.formatEther(gasFeeWei);

    console.log(`${colors.magenta}⛽ Gas Used: ${gasUsed.toString()}${colors.reset}`);
    console.log(`${colors.magenta}⛽ Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei${colors.reset}`);
    console.log(`${colors.magenta}⛽ Network Fee: ${gasFeeNative} MATIC${colors.reset}`);

    // --- LOG WALLET BALANCE AFTER ---
    const walletBalAfter = await provider.getBalance(wallet.address);
    const walletGasDelta = walletBalBefore - walletBalAfter;
    console.log(`${colors.magenta}⛽ Wallet Balance After: ${ethers.formatEther(walletBalAfter)} MATIC${colors.reset}`);
    console.log(`${colors.magenta}⛽ Gas Paid (wallet delta): ${ethers.formatEther(walletGasDelta)} MATIC${colors.reset}`);

    // --- Vault balance after ---
    const after = Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
    const netProfit = after - before;
    cumulativeProfit += netProfit;

    // --- PROFIT VS GAS SEPARATION ---
    console.log(`${colors.cyan}🏦 Vault Balance After: ${fmtNum(after)} USDC${colors.reset}`);
    console.log(`${colors.green}💰 Vault Profit (NO gas): ${fmtNum(netProfit)} USDC${colors.reset}`);
    console.log(`${colors.yellow}⚠️ Network fees were paid by wallet, NOT vault${colors.reset}`);

    // --- TRANSACTION SUMMARY ---
    console.log(`
──────── TRANSACTION SUMMARY ────────
Tx Hash: ${receipt.hash}

Vault Profit:     ${fmtNum(netProfit)} USDC
Gas Fee:          ${gasFeeNative} MATIC
Gas Paid By:      Wallet (${wallet.address})

Vault Impact:     ✅ PROFIT ONLY
Wallet Impact:    ⛽ GAS ONLY
─────────────────────────────────────
`);

    console.log(`${colors.cyan}🔔 Trade settled, profits retained in vault.${colors.reset}`);

  } catch (err) {
    const msg = err?.message || String(err);
    if (msg && (msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("too many requests"))) {
      console.log(`${colors.yellow}⚠️ RPC rate limit hit — backing off 10s${colors.reset}`);
      await sleep(10000);
      return;
    }
    console.log(`${colors.red}⚠️ Unexpected trade error: ${msg}${colors.reset}`);
  }
}

// ----------------- SCAN LOOP -----------------
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await safeGetAmountOut(buyRouter, token, MIN_TRADE_USDC);
          const sellOut = await safeGetAmountOut(sellRouter, token, MIN_TRADE_USDC);
          if (buyOut === null || sellOut === null) continue;

          const buyPrice = MIN_TRADE_USDC / buyOut;
          const sellPrice = MIN_TRADE_USDC / sellOut;
          const profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
          const profitPct = (profitUSDC / buyPrice) * 100;

          if (!saneProfitPct(profitPct)) continue;

          if (profitUSDC > 0) {
            console.log(`${colors.green}${symbol} | ${buyName}→${sellName} | expected profit=${fmtNum(profitUSDC)} USDC | profitPct=${fmtNum(profitPct)}%${colors.reset}`);
          } else {
            console.log(`${colors.red}${symbol} | ${buyName}→${sellName} | expected loss=${fmtNum(profitUSDC)} USDC | profitPct=${fmtNum(profitPct)}%${colors.reset}`);
          }

          if (profitPct >= MIN_PROFIT_PCT) {
            await executeTradeLive(buyRouter, sellRouter, token.address, MIN_TRADE_USDC);
            await sleep(1200);
          }
        } catch (e) {
          const msg = e?.message || String(e);
          console.log(`${colors.yellow}${symbol} | ${buyName}→${sellName} | scan error: ${msg}${colors.reset}`);
          if (msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("too many requests")) {
            await sleep(10000);
          }
        }
      }
    }
  }
}

// ----------------- MAIN -----------------
(async function main() {
  console.log(`${colors.cyan}🚀 Live arbitrage runner started${colors.reset}`);
  try {
    const usdcAddr = await vaultContract.USDC();
    console.log(`${colors.cyan}🏛 Vault USDC token: ${usdcAddr}${colors.reset}`);
    const owner = await vaultContract.owner();
    console.log(`${colors.cyan}👤 Vault Owner: ${owner}${colors.reset}`);
  } catch (e) {
    console.log(`${colors.yellow}⚠️ Could not read vault info: ${e.message}${colors.reset}`);
  }

  while (true) {
    try {
      await scanAllPairs();
    } catch (e) {
      console.log(`${colors.red}Fatal scanner error: ${e.message}${colors.reset}`);
    }
    await sleep(8000);
  }
})();
