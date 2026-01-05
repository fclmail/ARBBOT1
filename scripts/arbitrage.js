import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// CORE CONTRACTS
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS    = CONTRACT_ADDRESS;

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
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" }
];

// BOT SETTINGS
const SCAN_INTERVAL_MS = 8000;
const TRADE_AMOUNT_USDC = 0.14;
const MIN_PROFIT_USDC = 0.000005;
const MAX_SLIPPAGE_LOSS = 0.30;
const DRY_RUN = false;

// 🔑 GAS CONFIG (Polygon)
const ESTIMATED_GAS = 650_000;
const MATIC_USDC_PRICE = 0.75; // conservative manual estimate

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
  "function executeArbitrage(address,address,address,uint256,uint256) external",
  "event ArbitrageExecuted(address,address,address,address,uint256,uint256,uint256,uint256)",
  "function minProfitUSDC() view returns (uint256)"
];

/* =====================================================
   SETUP
===================================================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

const DEXES = [
  { name: "QuickSwap", address: QUICKSWAP_ROUTER },
  { name: "SushiSwap", address: SUSHISWAP_ROUTER },
  { name: "Dfyn",      address: DFYN_ROUTER },
  { name: "ApeSwap",   address: APESWAP_ROUTER }
].map(d => ({
  ...d,
  contract: new ethers.Contract(d.address, ROUTER_ABI, provider)
}));

let EXECUTING = false;

/* =====================================================
   HELPERS
===================================================== */

function log(msg, green = false) {
  console.log(green ? `\x1b[32m${msg}\x1b[0m` : msg);
}

async function getVaultBalance() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
}

async function getQuote(router, amountIn, path) {
  try {
    const out = await router.getAmountsOut(amountIn, path);
    return out.at(-1);
  } catch {
    return 0n;
  }
}

function buildPaths(token) {
  return [
    [USDC_ADDRESS, token],
    [USDC_ADDRESS, WMATIC, token],
    [USDC_ADDRESS, WETH, token]
  ];
}

/* =====================================================
   EVENT WATCHER
===================================================== */

arbContract.on("ArbitrageExecuted", (
  executor,
  buyRouter,
  sellRouter,
  token,
  amountIn,
  beforeUSDC,
  afterUSDC,
  profitUSDC
) => {
  log(`🎉 EVENT CONFIRMED | PROFIT ${(Number(profitUSDC)/1e6).toFixed(6)} USDC`, true);
});

/* =====================================================
   EXECUTION (SAFE + GUARANTEED)
===================================================== */

async function executeArb(best) {
  if (EXECUTING) return;
  EXECUTING = true;

  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
  const minReturn = ethers.parseUnits(best.profit.toString(), 6);

  try {
    await arbContract.executeArbitrage.staticCall(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      minReturn
    );

    if (DRY_RUN) {
      log("🧪 DRY RUN — execution skipped", true);
      return;
    }

    const tx = await arbContract.executeArbitrage(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      minReturn,
      { gasLimit: ESTIMATED_GAS }
    );

    log(`🚀 TX SENT ${tx.hash}`, true);
    await tx.wait();

  } catch (e) {
    log(`❌ EXECUTION FAILED: ${e.shortMessage || e.message}`);
  } finally {
    EXECUTING = false;
  }
}

/* =====================================================
   SINGLE-ROUTE OPTIMAL SCAN
===================================================== */

async function scanToken(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
  let best = null;

  for (const buy of DEXES) {
    for (const sell of DEXES) {
      if (buy === sell) continue;

      for (const path of buildPaths(token.address)) {
        const buyOut = await getQuote(buy.contract, amountIn, path);
        if (!buyOut) continue;

        const sellOut = await getQuote(sell.contract, buyOut, [...path].reverse());
        if (!sellOut) continue;

        const sellUSDC = Number(ethers.formatUnits(sellOut, 6));
        const profit = sellUSDC - TRADE_AMOUNT_USDC;

        if (profit <= 0) continue;

        const gasPrice = Number(await provider.getGasPrice()) / 1e18;
        const gasCostUSDC = gasPrice * ESTIMATED_GAS * MATIC_USDC_PRICE;

        if (profit < MIN_PROFIT_USDC + gasCostUSDC) continue;

        if (!best || profit > best.profit) {
          best = { token, buy, sell, profit };
        }
      }
    }
  }

  if (best) {
    log(`💰 OPTIMAL ${token.symbol} PROFIT ${best.profit.toFixed(6)} USDC`, true);
    await executeArb(best);
  }
}

/* =====================================================
   MAIN LOOP
===================================================== */

async function main() {
  log("⏱ Polygon Arbitrage Bot Started");

  while (true) {
    try {
      log(`🏦 Vault ${await getVaultBalance()} USDC`);
      for (const token of ERC20_TOKENS) {
        await scanToken(token);
      }
    } catch (e) {
      log(`❌ ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
