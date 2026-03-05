
// ---------------------------------------------------------
//  ARBITRAGE BOT – OPTION B (ABI MASKING)
//  - NO SOLIDITY CHANGES
//  - NO LOGIC CHANGES
//  - MANUAL CALLDATA ENCODING
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not found.");

const DRY_RUN = false;
const MIN_TRADE_USDC = .4;
const MIN_EXPECTED_PROFIT = 0.000001;
const MIN_PROFIT_PCT = 0.1;
const SLIPPAGE_PCT = 0.05;
const MAX_PROFIT_PCT = 550;

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

// ----------------- PROVIDER / WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- VAULT -----------------
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

// Masked ABI (read-only only)
const vaultReadAbi = [
  "function owner() view returns (address)",
  "function usdc() view returns (address)"
];

const vaultRead = new ethers.Contract(VAULT_ADDRESS, vaultReadAbi, provider);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ----------------- TOKENS -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ----------------- ROUTERS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ----------------- BASE FALLBACKS -----------------
const BASE_FALLBACKS = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
];

// ----------------- HELPERS -----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getVaultUsdcContract() {
  const usdcAddr = await vaultRead.usdc();
  return new ethers.Contract(usdcAddr, erc20Abi, provider);
}

async function safeGetAmountOut(routerAddr, tokenObj, amountUSDC) {
  try {
    const usdcAddr = (await vaultRead.usdc()).toLowerCase();
    const bases = [usdcAddr, ...BASE_FALLBACKS.filter(b => b !== usdcAddr)];
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn, address[] path) view returns (uint[])"],
      provider
    );

    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
    for (const base of bases) {
      try {
        const amounts = await router.getAmountsOut(amountInRaw, [base, tokenObj.address]);
        return Number(ethers.formatUnits(amounts[1], tokenObj.decimals));
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function saneProfitPct(pct) {
  return Number.isFinite(pct) && pct > -1000 && pct < MAX_PROFIT_PCT;
}

// ----------------- ABI MASKED EXECUTION -----------------
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  try {
    const usdc = await getVaultUsdcContract();
    const before = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
    console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

    const tokenObj = Object.values(tokens).find(t => t.address === tokenAddr) || { address: tokenAddr, decimals: 18 };

    const buyOut = await safeGetAmountOut(buyRouter, tokenObj, amountUSDC);
    const sellOut = await safeGetAmountOut(sellRouter, tokenObj, amountUSDC);
    if (!buyOut || !sellOut) return;

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    const expectedProfit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const pct = (expectedProfit / buyPrice) * 100;

    if (!saneProfitPct(pct)) return;
    if (expectedProfit <= MIN_EXPECTED_PROFIT || pct < MIN_PROFIT_PCT) return;

    console.log(`${colors.green}${tokenAddr} | Expected Profit: ${fmtNum(expectedProfit)} USDC | pct=${fmtNum(pct)}%${colors.reset}`);

    if (DRY_RUN) return;

    // ---------- ABI MASKING ----------
    const iface = new ethers.Interface([
      "function executeArbitrage(address,address,uint256,address[],address[],uint256)"
    ]);

    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
    const usdcAddr = await vaultRead.usdc();

    const pathToToken = [usdcAddr, tokenAddr];
    const pathToUSDC = [tokenAddr, usdcAddr];
    const deadline = Math.floor(Date.now() / 1000) + 60;

    const data = iface.encodeFunctionData("executeArbitrage", [
      buyRouter,
      sellRouter,
      amountInRaw,
      pathToToken,
      pathToUSDC,
      deadline
    ]);

    const tx = await wallet.sendTransaction({
      to: VAULT_ADDRESS,
      data
    });

    console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) return;

    const after = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
    const profit = after - before;
    console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(profit)} USDC${colors.reset}`);
  } catch (e) {
    console.log(`${colors.red}⚠️ Trade error: ${e.message}${colors.reset}`);
  }
}

// ----------------- SCAN LOOP -----------------
async function scanAllPairs() {
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;

        const buyOut = await safeGetAmountOut(buy, token, MIN_TRADE_USDC);
        const sellOut = await safeGetAmountOut(sell, token, MIN_TRADE_USDC);
        if (!buyOut || !sellOut) continue;

        const buyPrice = MIN_TRADE_USDC / buyOut;
        const sellPrice = MIN_TRADE_USDC / sellOut;
        const profit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
        const pct = (profit / buyPrice) * 100;

        if (pct >= MIN_PROFIT_PCT) {
          await executeTradeLive(buy, sell, token.address, MIN_TRADE_USDC);
          await sleep(1200);
        }
      }
    }
  }
}

// ----------------- MAIN -----------------
(async function main() {
  console.log(`${colors.cyan}🚀 Live arbitrage runner started${colors.reset}`);
  console.log(`${colors.cyan}🏛 Vault USDC: ${await vaultRead.usdc()}${colors.reset}`);
  console.log(`${colors.cyan}👤 Vault Owner: ${await vaultRead.owner()}${colors.reset}`);

  while (true) {
    await scanAllPairs();
    await sleep(8000);
  }
})();
