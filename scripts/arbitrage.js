// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – FULLY RESTORED + NEW VAULT
//  - Live scan logs (buy/sell/profit/vault/MATIC)
//  - Executes LowRevertArbVault.executeArbitrage
//  - Enforces MIN PROFIT = 0.00001 USDC
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE KEY missing");

const DRY_RUN = false;
const MIN_TRADE_USDC = 0.02;       // minimum trade in USDC
const MIN_EXPECTED_PROFIT = 0.00001; // 0.00001 USDC
const MIN_PROFIT_PCT = 0.3;        // minimum profit percent
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
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ----------------- PROVIDER & WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- NEW VAULT -----------------
const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";
const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)"
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

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

// ----------------- DEX ROUTERS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ----------------- BASE FALLBACKS -----------------
const BASES = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

// ----------------- HELPERS -----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sanePct(p) {
  return Number.isFinite(p) && p > -1000 && p < MAX_PROFIT_PCT;
}

async function getVaultUSDC() {
  const addr = await vault.USDC();
  return new ethers.Contract(addr, erc20Abi, provider);
}

async function vaultBalance() {
  const usdc = await getVaultUSDC();
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
}

async function maticBalance() {
  return Number(ethers.formatEther(await provider.getBalance(wallet.address)));
}

// Multi-base quote
async function quote(routerAddr, token, usdcAmt) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint,address[]) view returns (uint[])"],
    provider
  );
  const amtIn = ethers.parseUnits(usdcAmt.toString(), 6);

  for (const base of BASES) {
    try {
      const a = await router.getAmountsOut(amtIn, [base, token.address]);
      return Number(ethers.formatUnits(a[1], token.decimals));
    } catch {}
  }
  return null;
}

// ----------------- EXECUTE TRADE -----------------
async function executeTrade(buyRouter, sellRouter, token, amountUSDC) {
  const before = await vaultBalance();
  console.log(`${colors.cyan}🏦 Vault Before: ${fmt(before)} USDC${colors.reset}`);
  console.log(`${colors.cyan}⛽ MATIC: ${fmt(await maticBalance(), 4)}${colors.reset}`);

  const buyOut = await quote(buyRouter, token, amountUSDC);
  const sellOut = await quote(sellRouter, token, amountUSDC);
  if (!buyOut || !sellOut) return;

  const buyPrice = amountUSDC / buyOut;
  const sellPrice = amountUSDC / sellOut;
  const expectedProfit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
  const profitPct = (expectedProfit / buyPrice) * 100;

  if (expectedProfit < MIN_EXPECTED_PROFIT || profitPct < MIN_PROFIT_PCT || !sanePct(profitPct)) {
    console.log(`${colors.yellow}⚠️ Profit too low, skipping${colors.reset}`);
    return;
  }

  console.log(
    `${colors.green}💡 EXECUTING | Expected Profit: ${fmt(expectedProfit)} USDC | ${fmt(profitPct)}%${colors.reset}`
  );

  if (DRY_RUN) {
    console.log(`${colors.magenta}🔎 DRY RUN${colors.reset}`);
    return;
  }

  const amountIn = ethers.parseUnits(amountUSDC.toString(), 6);
  const minTokenOut = ethers.parseUnits((buyOut * (1 - SLIPPAGE_PCT / 100)).toString(), token.decimals);
  const minUSDCOut = ethers.parseUnits((amountUSDC + MIN_EXPECTED_PROFIT).toString(), 6);
  const deadline = Math.floor(Date.now() / 1000) + 120;

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    token.address,
    amountIn,
    minTokenOut,
    minUSDCOut,
    deadline
  );
  console.log(`${colors.green}🔁 TX SENT: ${tx.hash}${colors.reset}`);
  await tx.wait();

  const after = await vaultBalance();
  console.log(`${colors.green}💰 REAL PROFIT: ${fmt(after - before)} USDC${colors.reset}`);
}

// ----------------- SCANNER -----------------
async function scan() {
  for (const [sym, token] of Object.entries(tokens)) {
    for (const [bName, bRouter] of Object.entries(routers)) {
      for (const [sName, sRouter] of Object.entries(routers)) {
        if (bName === sName) continue;

        const buyOut = await quote(bRouter, token, MIN_TRADE_USDC);
        const sellOut = await quote(sRouter, token, MIN_TRADE_USDC);
        if (!buyOut || !sellOut) continue;

        const buyP = MIN_TRADE_USDC / buyOut;
        const sellP = MIN_TRADE_USDC / sellOut;
        const profit = (sellP - buyP) * (1 - SLIPPAGE_PCT / 100);
        const pct = (profit / buyP) * 100;
        if (!sanePct(pct)) continue;

        console.log(
          `${profit > 0 ? colors.green : colors.red}${sym} | ${bName}→${sName} | profit=${fmt(profit)} | pct=${fmt(pct)}%${colors.reset}`
        );

        if (profit >= MIN_EXPECTED_PROFIT && pct >= MIN_PROFIT_PCT) {
          await executeTrade(bRouter, sRouter, token, MIN_TRADE_USDC);
          await sleep(1200);
        }
      }
    }
  }
}

// ----------------- MAIN -----------------
(async () => {
  console.log(`${colors.cyan}🚀 Arbitrage bot started${colors.reset}`);
  console.log(`${colors.cyan}Vault: ${VAULT_ADDRESS}${colors.reset}`);

  while (true) {
    await scan();
    await sleep(8000);
  }
})();
