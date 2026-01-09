// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – FULL RESTORED VERSION (NEW VAULT)
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not found.");

const DRY_RUN = true;
const MIN_TRADE_USDC = 200000;
const MIN_EXPECTED_PROFIT = 0.00001; // 10 units (6 decimals)
const MIN_PROFIT_PCT = 1.0;
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
const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const vaultAbi = [
  {
    "name": "executeArbitrage",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "buyRouter", "type": "address" },
      { "name": "sellRouter", "type": "address" },
      { "name": "token", "type": "address" },
      { "name": "amountInUSDC", "type": "uint256" },
      { "name": "minTokenOut", "type": "uint256" },
      { "name": "minUSDCOut", "type": "uint256" },
      { "name": "deadline", "type": "uint256" }
    ],
    "outputs": []
  },
  { "name": "USDC", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{ "type": "address" }] },
  { "name": "owner", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{ "type": "address" }] }
];

const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function saneProfitPct(pct) {
  if (!Number.isFinite(pct)) return false;
  if (pct < -1000 || pct > MAX_PROFIT_PCT) return false;
  return true;
}

async function safeGetAmountOut(routerAddr, tokenObj, amountUSDC) {
  try {
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
      provider
    );

    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
    const bases = BASE_FALLBACKS;

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

async function getVaultUsdcContract() {
  const usdcAddr = await vaultContract.USDC();
  return new ethers.Contract(usdcAddr, erc20Abi, provider);
}

// ----------------- EXECUTE TRADE -----------------
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const tokenObj = Object.values(tokens).find(t => t.address === tokenAddr);
  const usdc = await getVaultUsdcContract();

  const before = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
  console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(before)} USDC${colors.reset}`);

  const buyOut = await safeGetAmountOut(buyRouter, tokenObj, amountUSDC);
  const sellOut = await safeGetAmountOut(sellRouter, tokenObj, amountUSDC);
  if (!buyOut || !sellOut) return;

  const buyPrice = amountUSDC / buyOut;
  const sellPrice = amountUSDC / sellOut;
  const profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
  const profitPct = (profitUSDC / buyPrice) * 100;

  if (profitUSDC <= MIN_EXPECTED_PROFIT || profitPct < MIN_PROFIT_PCT) return;
  if (!saneProfitPct(profitPct)) return;

  console.log(`${colors.green}${tokenAddr} | Expected Profit: ${fmtNum(profitUSDC)} USDC${colors.reset}`);

  if (DRY_RUN) {
    console.log(`${colors.magenta}🔎 DRY RUN — not sending tx${colors.reset}`);
    return;
  }

  const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
  const minUSDCOut = amountInRaw + 10n;
  const minTokenOut = 1n;
  const deadline = Math.floor(Date.now() / 1000) + 120;

  const tx = await vaultContract.executeArbitrage(
    buyRouter,
    sellRouter,
    tokenAddr,
    amountInRaw,
    minTokenOut,
    minUSDCOut,
    deadline
  );

  console.log(`${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`);
  await tx.wait();

  const after = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
  console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(after - before)} USDC${colors.reset}`);
}

// ----------------- SCANNER -----------------
async function scanAllPairs() {
  for (const token of Object.values(tokens)) {
    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {
        if (buyRouter === sellRouter) continue;
        await executeTradeLive(buyRouter, sellRouter, token.address, MIN_TRADE_USDC);
        await sleep(1200);
      }
    }
  }
}

// ----------------- MAIN LOOP -----------------
(async function main() {
  console.log(`${colors.cyan}🚀 Live arbitrage runner started${colors.reset}`);
  while (true) {
    await scanAllPairs();
    await sleep(8000);
  }
})();
