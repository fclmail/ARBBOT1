import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// VAULT / CONTRACT
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS    = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// TOKENS
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC       = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH         = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// DEX ROUTERS
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const DFYN_ROUTER      = "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73";
const APESWAP_ROUTER   = "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607";

// ARB TOKENS
const ERC20_TOKENS = [
  { symbol: "CRV",  address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
  { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" },
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cff1b9f619" }
];

// BOT SETTINGS
const SCAN_INTERVAL_MS = 8000;
const TRADE_AMOUNT_USDC = 0.10;
const MIN_PROFIT_USDC  = 0.001;   // MUST be >= contract minProfit
const MAX_SLIPPAGE_LOSS = 0.3;
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

const ARB_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256) external"
];

/* =====================================================
   SETUP
===================================================== */

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY missing");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet loaded:", wallet.address);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

const dexes = [
  { name: "QuickSwap", address: QUICKSWAP_ROUTER, contract: new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, provider) },
  { name: "SushiSwap", address: SUSHISWAP_ROUTER, contract: new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider) },
  { name: "Dfyn",      address: DFYN_ROUTER,      contract: new ethers.Contract(DFYN_ROUTER, ROUTER_ABI, provider) },
  { name: "ApeSwap",   address: APESWAP_ROUTER,   contract: new ethers.Contract(APESWAP_ROUTER, ROUTER_ABI, provider) }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

/* =====================================================
   HELPERS
===================================================== */

let EXECUTING = false;

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

function log(msg, green = false) {
  console.log(green ? `\x1b[32m${msg}\x1b[0m` : msg);
}

/* =====================================================
   PATH BUILDERS
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
   EXECUTION
===================================================== */

async function executeArb(buyRouter, sellRouter, token, profit, symbol) {
  if (EXECUTING) return;
  EXECUTING = true;

  try {
    const vaultBal = await getVaultBalance();
    if (vaultBal < TRADE_AMOUNT_USDC) {
      log("❌ Vault balance too low");
      return;
    }

    log(`💰 EXECUTING ${symbol} PROFIT ${profit.toFixed(6)}`, true);

    if (DRY_RUN) {
      log("🧪 DRY RUN – execution skipped", true);
      return;
    }

    const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
    const minReturn = ethers.parseUnits(
      (TRADE_AMOUNT_USDC + MIN_PROFIT_USDC).toString(),
      6
    );

    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountIn,
      minReturn
    );

    log(`🚀 TX SENT ${tx.hash}`, true);
    await tx.wait();

    const newBal = await getVaultBalance();
    log(`🏦 NEW VAULT BALANCE ${newBal.toFixed(6)}`, true);

  } catch (e) {
    log(`❌ EXECUTION FAILED: ${e.reason || e.message}`);
  } finally {
    EXECUTING = false;
  }
}

/* =====================================================
   SCANNER
===================================================== */

async function scanToken(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);

  for (const buyDex of dexes) {
    for (const sellDex of dexes) {
      if (buyDex.name === sellDex.name) continue;

      for (const buyPath of buildBuyPaths(token.address)) {
        const buyOut = await getQuote(buyDex.contract, amountIn, buyPath);
        if (buyOut === 0n) continue;

        for (const sellPath of buildSellPaths(token.address)) {
          const sellOut = await getQuote(sellDex.contract, buyOut, sellPath);
          if (sellOut === 0n) continue;

          const sellUSDC = Number(ethers.formatUnits(sellOut, 6));
          const profit = sellUSDC - TRADE_AMOUNT_USDC;

          log(
            `[${token.symbol}] BUY ${buyDex.name} → SELL ${sellDex.name} | P/L ${profit.toFixed(6)}`,
            profit > 0
          );

          if (profit >= MIN_PROFIT_USDC) {
            await executeArb(
              buyDex.address,
              sellDex.address,
              token.address,
              profit,
              token.symbol
            );
            return; // stop after success
          }
        }
      }
    }
  }
}

/* =====================================================
   MAIN LOOP
===================================================== */

async function main() {
  log("⏱ Polygon Arbitrage Bot Started");

  while (true) {
    try {
      log(`🏦 Vault USDC ${(await getVaultBalance()).toFixed(6)}`);
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
