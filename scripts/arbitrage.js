
import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// CORE CONTRACTS
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS    = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

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
  { symbol: "CRV",  address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
  { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" },
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cff1b9f619" }
];

// BOT SETTINGS (OPTIMIZED FOR GREEN LINES)
const SCAN_INTERVAL_MS = 8000;
const TRADE_AMOUNT_USDC = .100;        // 🔑 smaller size = more arb
const MIN_PROFIT_USDC = 0.00005;         // realistic Polygon profit
const MAX_SLIPPAGE_LOSS = 0.3;         // skip >30% loss routes
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
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet loaded:", wallet.address);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

const quickswap = new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, provider);
const sushiswap = new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider);
const dfyn      = new ethers.Contract(DFYN_ROUTER, ROUTER_ABI, provider);
const apeswap   = new ethers.Contract(APESWAP_ROUTER, ROUTER_ABI, provider);

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

const DEXES = [
  { name: "QuickSwap", contract: quickswap },
  { name: "SushiSwap", contract: sushiswap },
  { name: "Dfyn",      contract: dfyn },
  { name: "ApeSwap",   contract: apeswap }
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
   PATH BUILDERS (5 FALLBACK ROUTES)
===================================================== */

function buildBuyPaths(token) {
  return [
    [USDC_ADDRESS, token],
    [USDC_ADDRESS, WMATIC, token],
    [USDC_ADDRESS, WETH, token],
    [USDC_ADDRESS, WMATIC, WETH, token],
    [USDC_ADDRESS, WETH, WMATIC, token]
  ];
}

function buildSellPaths(token) {
  return [
    [token, USDC_ADDRESS],
    [token, WMATIC, USDC_ADDRESS],
    [token, WETH, USDC_ADDRESS],
    [token, WMATIC, WETH, USDC_ADDRESS],
    [token, WETH, WMATIC, USDC_ADDRESS]
  ];
}

/* =====================================================
   LOGGING
===================================================== */

function log(line, green = false) {
  process.stdout.write(
    green ? `\x1b[32m${line}\x1b[0m\n` : `${line}\n`
  );
}

/* =====================================================
   EXECUTION
===================================================== */

async function executeArb(symbol, profit) {
  log(`💰 ARBITRAGE FOUND ${symbol} PROFIT ${profit.toFixed(4)}`, true);

  if (DRY_RUN) {
    log("🧪 DRY RUN – tx not sent", true);
    return;
  }

  const tx = await arbContract.executeArbitrage(
    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
  );

  log(`🚀 TX SENT ${tx.hash}`, true);
  await tx.wait();

  const newBal = await getVaultBalance();

  log(`✅ ARBITRAGE COMPLETED`, true);
  log(`🏦 NEW VAULT BALANCE ${newBal.toFixed(2)}`, true);
}

/* =====================================================
   PARALLEL SCANNER
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
        tasks.push((async () => {
          const buyOut = await getQuote(buyDex.contract, amountIn, buyPath);
          if (buyOut === 0n) return;

          for (const sellPath of sellPaths) {
            const sellOut = await getQuote(sellDex.contract, buyOut, sellPath);
            if (sellOut === 0n) continue;

            const sellUSDC = Number(ethers.formatUnits(sellOut, 6));

            if (sellUSDC < TRADE_AMOUNT_USDC * (1 - MAX_SLIPPAGE_LOSS)) return;

            const profit = sellUSDC - TRADE_AMOUNT_USDC;

            const line =
              `[${new Date().toISOString()}] ${token.symbol} ` +
              `BUY ${buyDex.name} ${TRADE_AMOUNT_USDC.toFixed(2)} → ` +
              `SELL ${sellDex.name} ${sellUSDC.toFixed(2)} ` +
              `P/L ${profit.toFixed(4)}`;

            log(line, profit > 0);

            if (profit >= MIN_PROFIT_USDC) {
              await executeArb(token.symbol, profit);
            }
          }
        })());
      }
    }
  }

  await Promise.allSettled(tasks);
}

/* =====================================================
   MAIN LOOP
===================================================== */

async function attemptArbitrage() {
  log(`🏦 Vault USDC ${await getVaultBalance().then(v => v.toFixed(4))}`);

  for (const token of ERC20_TOKENS) {
    await scanToken(token);
  }
}

async function main() {
  log("⏱ Polygon Arb Bot Started");

  while (true) {
    try {
      await attemptArbitrage();
    } catch (e) {
      console.error("❌ Error", e);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
