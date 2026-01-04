import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// CORE CONTRACT / VAULT (same address)
const CONTRACT_ADDRESS = "0xFBF3582c5fb8AE49726996105Cb1f2Aa6AbdC2E2";
const VAULT_ADDRESS    = "0xFBF3582c5fb8AE49726996105Cb1f2Aa6AbdC2E2";

// BASE TOKENS
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC       = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH         = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// DEX ROUTERS
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const DFYN_ROUTER      = "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73";
const APESWAP_ROUTER   = "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607";

// TOKENS
const ERC20_TOKENS = [
  { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" },
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cff1b9f619" }
];

// BOT SETTINGS
const SCAN_INTERVAL_MS = 8000;
const TRADE_AMOUNT_USDC = 0.10;
const MIN_PROFIT_USDC = 0.000001; // matches contract minProfit = 1
const MAX_SLIPPAGE_LOSS = 0.30;
const DRY_RUN = false;

/* =====================================================
   ABIs
===================================================== */

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

// ✅ FIXED ABI — MATCHES DEPLOYED CONTRACT
const ARB_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn, uint256 minOut) external"
];

/* =====================================================
   SETUP
===================================================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet:", wallet.address);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

const quickswap   = new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, provider);
const sushiswap  = new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider);
const dfyn        = new ethers.Contract(DFYN_ROUTER, ROUTER_ABI, provider);
const apeswap     = new ethers.Contract(APESWAP_ROUTER, ROUTER_ABI, provider);

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

const DEXES = [
  { name: "QuickSwap", contract: quickswap },
  { name: "SushiSwap", contract: sushiswap },
  { name: "Dfyn", contract: dfyn },
  { name: "ApeSwap", contract: apeswap }
];

/* =====================================================
   HELPERS
===================================================== */

async function getVaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function getQuote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return 0n;
  }
}

/* =====================================================
   PATHS
===================================================== */

function buildBuyPaths(token) {
  return [
    [USDC_ADDRESS, token],
    [USDC_ADDRESS, WMATIC, token],
    [USDC_ADDRESS, WETH, token]
  ];
}

function buildSellPaths(token) {
  return [
    [token, USDC_ADDRESS],
    [token, WMATIC, USDC_ADDRESS],
    [token, WETH, USDC_ADDRESS]
  ];
}

/* =====================================================
   LOGGING
===================================================== */

function log(msg, green = false) {
  console.log(green ? `\x1b[32m${msg}\x1b[0m` : msg);
}

/* =====================================================
   EXECUTION (FIXED)
===================================================== */

async function executeArb(buyRouter, sellRouter, token, amountIn, minOut, profit) {
  if (DRY_RUN) {
    log("🧪 DRY RUN — skipped", true);
    return;
  }

  log(`💰 EXECUTING ${profit.toFixed(6)} USDC`, true);

  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountIn,
      minOut
    );

    log(`🚀 TX SENT ${tx.hash}`, true);
    await tx.wait();

    log(`🏦 VAULT ${await getVaultBalance()} USDC`, true);
  } catch (e) {
    // Provide more context if revert data available
    const msg = e?.message ?? "Unknown error";
    console.error("❌ ARB EXECUTION FAILED", msg);
  }
}

/* =====================================================
   SCANNER
===================================================== */

async function scanToken(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);

  for (const buyDex of DEXES) {
    for (const sellDex of DEXES) {
      if (buyDex === sellDex) continue;

      for (const buyPath of buildBuyPaths(token.address)) {
        const buyOut = await getQuote(buyDex.contract, amountIn, buyPath);
        if (buyOut === 0n) continue;

        for (const sellPath of buildSellPaths(token.address)) {
          const sellOut = await getQuote(sellDex.contract, buyOut, sellPath);
          if (sellOut === 0n) continue;

          const sellUSDC = Number(ethers.formatUnits(sellOut, 6));
          const profit = sellUSDC - TRADE_AMOUNT_USDC;

          log(
            `[${token.symbol}] BUY ${buyDex.name} → SELL ${sellDex.name} | P/L ${profit.toFixed(6)}`
          );

          if (profit >= MIN_PROFIT_USDC) {
            await executeArb(
              buyDex.contract.address,
              sellDex.contract.address,
              token.address,
              amountIn,
              sellOut,
              profit
            );
            return; // 🔑 execute once then resume scan loop
          }
        }
      }
    }
  }
}

/* =====================================================
   MAIN LOOP (CONTINUOUS)
===================================================== */

async function main() {
  log("⏱ ARB BOT STARTED");

  while (true) {
    try {
      log(`🏦 Vault ${await getVaultBalance()} USDC`);
      for (const token of ERC20_TOKENS) {
        await scanToken(token);
      }
    } catch (e) {
      console.error("❌ LOOP ERROR", e);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
