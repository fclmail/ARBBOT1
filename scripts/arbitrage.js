import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// VAULT CONTRACT
const VAULT_ADDRESS = "0xFBF3582c5fb8AE49726996105Cb1f2Aa6AbdC2E2";

// BASE TOKENS
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

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
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" }
];

// BOT SETTINGS
const SCAN_INTERVAL_MS = 8000;
const TRADE_AMOUNT_USDC = 0.1;
const MIN_PROFIT_USDC = 0.000001;
const MAX_SLIPPAGE_LOSS = 3;
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

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountInUSDC, uint256 minReturnUSDC) external"
];

/* =====================================================
   SETUP
===================================================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

const DEXES = [
  { name: "QuickSwap", address: QUICKSWAP_ROUTER },
  { name: "SushiSwap", address: SUSHISWAP_ROUTER },
  { name: "Dfyn", address: DFYN_ROUTER },
  { name: "ApeSwap", address: APESWAP_ROUTER }
].map(d => ({
  ...d,
  contract: new ethers.Contract(d.address, ROUTER_ABI, provider)
}));

/* =====================================================
   HELPERS
===================================================== */

async function getVaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function getQuote(router, amountIn, path) {
  try {
    const out = await router.getAmountsOut(amountIn, path);
    return out[out.length - 1];
  } catch {
    return 0n;
  }
}

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

function log(msg, green = false) {
  console.log(green ? `\x1b[32m${msg}\x1b[0m` : msg);
}

/* =====================================================
   EXECUTION
===================================================== */

async function executeArb(buyRouter, sellRouter, token, amountIn, profit) {
  log(`💰 EXECUTING ${profit.toFixed(6)} USDC`, true);

  if (DRY_RUN) {
    log("🧪 DRY RUN – SKIPPED", true);
    return;
  }

  const minReturn =
    amountIn + ethers.parseUnits(MIN_PROFIT_USDC.toString(), 6);

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    token,
    amountIn,
    minReturn
  );

  log(`🚀 TX SENT ${tx.hash}`, true);
  await tx.wait();

  log(`🏦 VAULT ${await getVaultBalance()}`, true);
}

/* =====================================================
   SCANNER
===================================================== */

async function scanToken(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);

  for (const buy of DEXES) {
    for (const sell of DEXES) {
      if (buy.name === sell.name) continue;

      for (const buyPath of buildBuyPaths(token.address)) {
        const buyOut = await getQuote(buy.contract, amountIn, buyPath);
        if (!buyOut) continue;

        for (const sellPath of buildSellPaths(token.address)) {
          const sellOut = await getQuote(sell.contract, buyOut, sellPath);
          if (!sellOut) continue;

          const usdcOut = Number(ethers.formatUnits(sellOut, 6));
          const profit = usdcOut - TRADE_AMOUNT_USDC;

          log(
            `[${token.symbol}] BUY ${buy.name} → SELL ${sell.name} | P/L ${profit.toFixed(6)}`,
            profit > 0
          );

          if (profit >= MIN_PROFIT_USDC) {
            await executeArb(
              buy.address,
              sell.address,
              token.address,
              amountIn,
              profit
            );
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
  log("🚀 Polygon Arbitrage Bot Started");

  while (true) {
    try {
      log(`🏦 VAULT ${await getVaultBalance()}`);
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
