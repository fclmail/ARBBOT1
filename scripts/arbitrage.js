import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS    = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC       = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH         = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const DFYN_ROUTER      = "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73";
const APESWAP_ROUTER   = "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607";

/* =====================================================
   TOKENS
===================================================== */

const ERC20_TOKENS = [
  { symbol: "CRV",  address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
  { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" },
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cff1b9f619" }
];

/* =====================================================
   BOT SETTINGS (GREEN LINE TUNED)
===================================================== */

const SCAN_INTERVAL_MS   = 4000;
const TRADE_AMOUNT_USDC = 100;        // 🔑 smaller = less slippage
const MIN_PROFIT_USDC   = 0.05;       // realistic post-fee threshold
const DRY_RUN           = true;

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
  "function executeArbitrage(uint256 amount) external"
];

/* =====================================================
   SETUP
===================================================== */

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY missing");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet loaded:", wallet.address);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

const DEXES = [
  { name: "QuickSwap", contract: new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, provider) },
  { name: "SushiSwap", contract: new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider) },
  { name: "Dfyn",      contract: new ethers.Contract(DFYN_ROUTER, ROUTER_ABI, provider) },
  { name: "ApeSwap",   contract: new ethers.Contract(APESWAP_ROUTER, ROUTER_ABI, provider) }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

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
   PATHS (5 FALLBACK ROUTES)
===================================================== */

const buildBuyPaths = (t) => [
  [USDC_ADDRESS, t],
  [USDC_ADDRESS, WMATIC, t],
  [USDC_ADDRESS, WETH, t],
  [USDC_ADDRESS, WMATIC, WETH, t],
  [USDC_ADDRESS, WETH, WMATIC, t]
];

const buildSellPaths = (t) => [
  [t, USDC_ADDRESS],
  [t, WMATIC, USDC_ADDRESS],
  [t, WETH, USDC_ADDRESS],
  [t, WMATIC, WETH, USDC_ADDRESS],
  [t, WETH, WMATIC, USDC_ADDRESS]
];

/* =====================================================
   LOGGING
===================================================== */

function logLine(line, green = false) {
  process.stdout.write(
    green ? `\x1b[32m${line}\x1b[0m\n` : `${line}\n`
  );
}

/* =====================================================
   EXECUTION
===================================================== */

async function executeArb(symbol, profit) {
  logLine(`💰 Arbitrage found for ${symbol} profit ${profit.toFixed(4)}`, true);

  if (DRY_RUN) {
    logLine("🧪 DRY RUN – tx skipped");
    return;
  }

  const tx = await arbContract.executeArbitrage(
    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
  );

  logLine(`🚀 Tx sent ${tx.hash}`);
  await tx.wait();

  logLine(`🏦 New vault balance ${await getVaultBalance()}`, true);
}

/* =====================================================
   PARALLEL SCANNER (GREEN-LINE ENABLED)
===================================================== */

async function scanToken(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
  const buyPaths = buildBuyPaths(token.address);
  const sellPaths = buildSellPaths(token.address);

  const tasks = [];

  for (const buyDex of DEXES) {
    for (const sellDex of DEXES) {
      if (buyDex.name === sellDex.name) continue; // 🔑 skip same DEX

      for (const buyPath of buyPaths) {
        for (const sellPath of sellPaths) {

          tasks.push((async () => {
            const buyOut = await getQuote(buyDex.contract, amountIn, buyPath);
            if (buyOut === 0n) return;

            const sellOut = await getQuote(sellDex.contract, buyOut, sellPath);
            if (sellOut === 0n) return;

            const sellUSDC = Number(ethers.formatUnits(sellOut, 6));

            // 🔑 catastrophic slippage guard
            if (sellUSDC < TRADE_AMOUNT_USDC * 0.85) return;

            const profit = sellUSDC - TRADE_AMOUNT_USDC;
            const ts = new Date().toISOString();

            const line =
              `[${ts}] ${token.symbol} BUY ${buyDex.name} → SELL ${sellDex.name} ` +
              `${sellUSDC.toFixed(2)} P/L ${profit.toFixed(4)}`;

            logLine(line, profit >= MIN_PROFIT_USDC);

            if (profit >= MIN_PROFIT_USDC) {
              await executeArb(token.symbol, profit);
            }
          })());
        }
      }
    }
  }

  await Promise.all(tasks);
}

/* =====================================================
   MAIN LOOP
===================================================== */

async function main() {
  console.log("⏱ Polygon Arb Bot Started");

  while (true) {
    try {
      logLine(`🏦 Vault USDC ${await getVaultBalance()}`);
      await Promise.all(ERC20_TOKENS.map(scanToken));
    } catch (e) {
      console.error("❌ Error", e);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
