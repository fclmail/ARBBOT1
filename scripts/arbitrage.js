import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ADDRESSES (REPLACE THESE 3)
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TOKEN_ADDRESS = "0x172370d5cd63279efa6d502dab29171933a610af"; // CRV

// STABLES / BASES
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// ROUTERS
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// ADDITIONAL DEX ROUTERS (FILLED)
const ADDITIONAL_DEX1_ROUTER = "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73"; // Dfyn
const ADDITIONAL_DEX2_ROUTER = "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"; // ApeSwap

// TOKENS
const TOKEN_A = TOKEN_ADDRESS; // CRV
const TOKEN_B = "0xd6df932a45c0f255f85145f286ea0b292b21c90b"; // AAVE
const TOKEN_C = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"; // LINK
const TOKEN_D = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"; // USDT
const TOKEN_E = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"; // WBTC
const TOKEN_F = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"; // WETH

/**** Dynamic list of ERC20s to arbitrage against ****/
const ERC20_TOKENS = [
  { symbol: "CRV",  address: TOKEN_A },
  { symbol: "AAVE", address: TOKEN_B },
  { symbol: "LINK", address: TOKEN_C },
  { symbol: "USDT", address: TOKEN_D },
  { symbol: "WBTC", address: TOKEN_E },
  { symbol: "WETH", address: TOKEN_F }
];

// BOT SETTINGS
const SCAN_INTERVAL_MS = 5000;
const TRADE_AMOUNT_USDC = 0.1;
const MIN_PROFIT_USDC = 0.001;
const DRY_RUN = true;

const VAULT_BALANCE_THRESHOLD_USDC = 0.02;

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
const dex1 = new ethers.Contract(ADDITIONAL_DEX1_ROUTER, ROUTER_ABI, provider);
const dex2 = new ethers.Contract(ADDITIONAL_DEX2_ROUTER, ROUTER_ABI, provider);

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
    return amounts[amounts.length - 1];
  } catch {
    return 0n;
  }
}

/* =====================================================
   PATHS
===================================================== */

const BUY_PATHS = [
  [USDC_ADDRESS, TOKEN_A],
  [USDC_ADDRESS, WMATIC, TOKEN_A],
  [USDC_ADDRESS, WETH, TOKEN_A],
  [USDC_ADDRESS, WMATIC, WETH, TOKEN_A],

  [USDC_ADDRESS, TOKEN_B],
  [USDC_ADDRESS, WMATIC, TOKEN_B],
  [USDC_ADDRESS, WETH, TOKEN_B],
  [USDC_ADDRESS, WMATIC, WETH, TOKEN_B],

  [USDC_ADDRESS, TOKEN_C],
  [USDC_ADDRESS, WMATIC, TOKEN_C],
  [USDC_ADDRESS, WETH, TOKEN_C],
  [USDC_ADDRESS, WMATIC, WETH, TOKEN_C]
];

const SELL_PATHS = [
  [TOKEN_A, USDC_ADDRESS],
  [TOKEN_A, WMATIC, USDC_ADDRESS],
  [TOKEN_A, WETH, USDC_ADDRESS],
  [TOKEN_A, WETH, WMATIC, USDC_ADDRESS],

  [TOKEN_B, USDC_ADDRESS],
  [TOKEN_B, WMATIC, USDC_ADDRESS],
  [TOKEN_B, WETH, USDC_ADDRESS],
  [TOKEN_B, WMATIC, WETH, USDC_ADDRESS],

  [TOKEN_C, USDC_ADDRESS],
  [TOKEN_C, WMATIC, USDC_ADDRESS],
  [TOKEN_C, WETH, USDC_ADDRESS],
  [TOKEN_C, WMATIC, WETH, USDC_ADDRESS]
];

/* =====================================================
   TWO-DEX ARBITRAGE
===================================================== */

async function calculateSide(routerBuy, routerSell, amountUSDC) {
  const amountIn = ethers.parseUnits(amountUSDC.toString(), 6);

  let best = {
    buyTokens: 0n,
    sellUSDC: 0n,
    profit: -Infinity,
    pathIndex: -1
  };

  for (let i = 0; i < BUY_PATHS.length; i++) {
    const buy = await getQuote(routerBuy, amountIn, BUY_PATHS[i]);
    if (buy === 0n) continue;

    const sell = await getQuote(routerSell, buy, SELL_PATHS[i]);
    if (sell === 0n) continue;

    const profit = Number(ethers.formatUnits(sell, 6)) - amountUSDC;
    if (profit > best.profit) {
      best = { buyTokens: buy, sellUSDC: sell, profit, pathIndex: i };
    }
  }

  return best;
}

/* =====================================================
   LOOP
===================================================== */

async function attemptArbitrage() {
  console.log(`🏦 Vault USDC: ${await getVaultBalance()}`);
  console.log("🔎 Attempting arbitrage...");

  const [quickToSushi, sushiToQuick] = await Promise.all([
    calculateSide(quickswap, sushiswap, TRADE_AMOUNT_USDC),
    calculateSide(sushiswap, quickswap, TRADE_AMOUNT_USDC)
  ]);

  console.log("🔁 QUICK → SUSHI", quickToSushi);
  console.log("🔁 SUSHI → QUICK", sushiToQuick);
}

/* =====================================================
   MAIN
===================================================== */

async function main() {
  console.log("⏱ Polygon Arb Bot Started");

  while (true) {
    try {
      await attemptArbitrage();
    } catch (err) {
      console.error("❌ Error:", err);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
