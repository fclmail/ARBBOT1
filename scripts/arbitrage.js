// scripts/arb.js
// =======================================================
// POLYGON QUICKSWAP ↔ SUSHISWAP ARBITRAGE BOT
// PRICE-RATIO SCANNING (HTML-STYLE)
// SMART CONTRACT ENFORCES REALITY
// =======================================================

import { ethers } from "ethers";

// ================= ANSI COLORS =================
const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;

// ================= CONFIG =================
const DRY_RUN = false;
const TRADE_USDC = 0.010;
const MIN_PROFIT_PCT = 0.01;
const CHECK_DELAY_MS = 3000;
const GAS_MULTIPLIER = 1.3;

// ================= POLYGON CONSTANTS =================
const RPC = "https://polygon-rpc.com";

const USDCe = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH  = "0x172370d5cd63279efa6d502dab29171933a610af";

const QUICKSWAP = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const VAULT = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// ================= PROVIDER / WALLET =================
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ================= ABI =================
const VAULT_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

// ================= HELPERS =================
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (f, i) => ((f - i) / i) * 100;

// ================= ROUTERS =================
const routers = [
  { name: "QuickSwap", addr: QUICKSWAP },
  { name: "SushiSwap", addr: SUSHISWAP }
];

// =======================================================
// MAIN LOOP
// =======================================================
async function run() {

  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY missing");
  }

  console.log(cyan(`\n⏱ ${now()}  Polygon Arb Bot Started`));

  const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

  while (true) {

    for (const buy of routers) {
      for (const sell of routers) {

        if (buy.addr === sell.addr) continue;

        console.log(cyan(`\n🔍 ${buy.name} ➜ ${sell.name}`));

        try {
          const amountIn = ethers.parseUnits(
            TRADE_USDC.toString(),
            6
          );

          const buyRouter  = new ethers.Contract(buy.addr, ROUTER_ABI, provider);
          const sellRouter = new ethers.Contract(sell.addr, ROUTER_ABI, provider);

          const path = [USDCe, WETH];

          // ================= INDEPENDENT PRICES =================
          const buyQuote  = await buyRouter.getAmountsOut(amountIn, path);
          const sellQuote = await sellRouter.getAmountsOut(amountIn, path);

          const wethBuy  = Number(ethers.formatUnits(buyQuote[1], 18));
          const wethSell = Number(ethers.formatUnits(sellQuote[1], 18));

          const buyPrice  = TRADE_USDC / wethBuy;
          const sellPrice = TRADE_USDC / wethSell;

          const profitUSDC = sellPrice - buyPrice;
          const profitPct  = (profitUSDC / buyPrice) * 100;

          console.log(`📈 ${buy.name} price: ${buyPrice.toFixed(6)} USDC/WETH`);
          console.log(`📉 ${sell.name} price: ${sellPrice.toFixed(6)} USDC/WETH`);
          console.log(`💵 Price diff: ${profitUSDC.toFixed(6)} USDC (${profitPct.toFixed(3)}%)`);

          if (profitPct < MIN_PROFIT_PCT) {
            console.log(yellow("⚠️ Below minimum profit – skipping"));
            continue;
          }

          console.log(green("🚨 PRICE-RATIO OPPORTUNITY"));

          if (DRY_RUN) {
            console.log(cyan("🧪 DRY RUN – execution delegated to contract"));
            continue;
          }

          const fee = await provider.getFeeData();
          const gasPrice =
            fee.gasPrice * BigInt(Math.floor(GAS_MULTIPLIER * 100)) / 100n;

          const minReturnUSDC =
            amountIn +
            BigInt(Math.floor(Number(amountIn) * (MIN_PROFIT_PCT / 100)));

          const tx = await vault.executeArbitrage(
            buy.addr,
            sell.addr,
            WETH,
            amountIn,
            minReturnUSDC,
            { gasPrice }
          );

          console.log(green(`🚀 TX SENT: ${tx.hash}`));
          await tx.wait();
          console.log(green("✅ CONFIRMED"));

        } catch (err) {
          console.log(red("❌ REVERT / MIN PROFIT ENFORCED"));
          console.log("Vault funds protected");
        }

        await sleep(CHECK_DELAY_MS);
      }
    }
  }
}

run();
