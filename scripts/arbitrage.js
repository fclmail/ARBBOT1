// scripts/arbitrage.js
// ---------------------------------------------------------
//  BLIND SKEW ARBITRAGE BOT (ON-CHAIN PROFIT ENFORCED)
//  - ZERO OFF-CHAIN PROFIT FILTERS
//  - ABI MASKED EXECUTION
//  - 3s TX DELAY
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* ===================== CONFIG ===================== */

const RPC =
  process.env.RPC_POLYGON || "https://polygon-bor-rpc.publicnode.com";

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");

const DRY_RUN = false;

// Trade sizing
const MIN_TRADE_USDC = 0.12;

// JS-side SOFT filter (not authoritative)
const JS_MIN_PROFIT = 0.00001; // adjustable

// Timing
const TX_DELAY_MS = 3000;
const SCAN_DELAY_MS = 8000;

// Slippage is informational only
const SLIPPAGE_PCT = 5;

/* ===================== COLORS ===================== */

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

const fmt = (n, d = 6) => Number(n).toFixed(d);

/* ===================== PROVIDER ===================== */

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

/* ===================== VAULT ===================== */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultReadAbi = [
  "function owner() view returns (address)",
  "function usdc() view returns (address)"
];

const vaultRead = new ethers.Contract(
  VAULT_ADDRESS,
  vaultReadAbi,
  provider
);

/* ===================== ERC20 ===================== */

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

/* ===================== TOKENS ===================== */

const tokens = {
  AAVE: {
    address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    decimals: 18
  },
  CRV: {
    address: "0x172370d5cd63279efa6d502dab29171933a610af",
    decimals: 18
  },
  LINK: {
    address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    decimals: 18
  },
  WBTC: {
    address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    decimals: 8
  }
};

/* ===================== ROUTERS ===================== */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ===================== BASE FALLBACKS ===================== */

const BASE_FALLBACKS = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

/* ===================== HELPERS ===================== */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getVaultUsdcContract() {
  const usdcAddr = await vaultRead.usdc();
  return new ethers.Contract(usdcAddr, erc20Abi, provider);
}

async function safeGetAmountOut(routerAddr, token, amountUSDC) {
  try {
    const usdcAddr = (await vaultRead.usdc()).toLowerCase();
    const bases = [
      usdcAddr,
      ...BASE_FALLBACKS.filter(b => b !== usdcAddr)
    ];

    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
      provider
    );

    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);

    for (const base of bases) {
      try {
        const out = await router.getAmountsOut(
          amountInRaw,
          [base, token.address]
        );
        return Number(
          ethers.formatUnits(out[out.length - 1], token.decimals)
        );
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function isPositiveSkew(buyOut, sellOut) {
  return (
    Number.isFinite(buyOut) &&
    Number.isFinite(sellOut) &&
    buyOut > sellOut
  );
}

/* ===================== EXECUTION ===================== */

async function executeTradeLive(buyRouter, sellRouter, token, amountUSDC) {
  try {
    const usdc = await getVaultUsdcContract();
    const before = Number(
      ethers.formatUnits(
        await usdc.balanceOf(VAULT_ADDRESS),
        6
      )
    );

    const buyOut = await safeGetAmountOut(buyRouter, token, amountUSDC);
    const sellOut = await safeGetAmountOut(sellRouter, token, amountUSDC);

    if (!isPositiveSkew(buyOut, sellOut)) return;

    const roughDelta =
      (buyOut - sellOut) * (amountUSDC / buyOut);

    if (roughDelta < JS_MIN_PROFIT) {
      console.log(
        `${colors.yellow}⚠️ Skew too small (JS soft): ${fmt(roughDelta)} USDC${colors.reset}`
      );
      return;
    }

    console.log(
      `${colors.cyan}🧠 BLIND SKEW TRIGGER${colors.reset} | ` +
      `${token.address} | buyOut=${fmt(buyOut)} sellOut=${fmt(sellOut)}`
    );

    if (DRY_RUN) return;

    const iface = new ethers.Interface([
      "function executeArbitrage(address,address,uint256,address[],address[],uint256)"
    ]);

    const usdcAddr = await vaultRead.usdc();
    const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
    const deadline = Math.floor(Date.now() / 1000) + 60;

    const data = iface.encodeFunctionData("executeArbitrage", [
      buyRouter,
      sellRouter,
      amountInRaw,
      [usdcAddr, token.address],
      [token.address, usdcAddr],
      deadline
    ]);

    const tx = await wallet.sendTransaction({
      to: VAULT_ADDRESS,
      data
    });

    console.log(
      `${colors.green}🔁 TX SENT — ${tx.hash}${colors.reset}`
    );

    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) return;

    const after = Number(
      ethers.formatUnits(
        await usdc.balanceOf(VAULT_ADDRESS),
        6
      )
    );

    console.log(
      `${colors.green}💰 ON-CHAIN PROFIT: ${fmt(after - before)} USDC${colors.reset}`
    );

    console.log(
      `${colors.magenta}⏱ Waiting 3 seconds before next tx...${colors.reset}`
    );

    await sleep(TX_DELAY_MS);

  } catch (e) {
    console.log(
      `${colors.red}❌ TX FAILED / REVERTED: ${e.message}${colors.reset}`
    );
  }
}

/* ===================== SCAN LOOP ===================== */

async function scanAllPairs() {
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await executeTradeLive(
          buy,
          sell,
          token,
          MIN_TRADE_USDC
        );
      }
    }
  }
}

/* ===================== MAIN ===================== */

(async function main() {
  console.log(`${colors.cyan}🚀 Blind Skew Arbitrage Runner Started${colors.reset}`);
  console.log(`${colors.cyan}🏛 Vault USDC: ${await vaultRead.usdc()}${colors.reset}`);
  console.log(`${colors.cyan}👤 Vault Owner: ${await vaultRead.owner()}${colors.reset}`);
  console.log(`${colors.cyan}🧾 JS Min Profit (soft): ${JS_MIN_PROFIT} USDC${colors.reset}`);

  while (true) {
    await scanAllPairs();
    await sleep(SCAN_DELAY_MS);
  }
})();
