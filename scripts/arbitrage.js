// scripts/arb.js
// =======================================================
// POLYGON QUICKSWAP ↔ SUSHISWAP ARBITRAGE BOT
// MULTI-HOP + LIQUIDITY FALLBACK ROUTES
// NO EXTERNAL DEPENDENCIES (CI SAFE)
// =======================================================

import { ethers } from "ethers";

// ================= ANSI COLORS =================
const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;

// ================= CONFIG =================
const DRY_RUN = true;
const SLIPPAGE = 0.00;
const TRADE_USDC = 10000.0;
const MIN_PROFIT_PCT = 0.0020;
const CHECK_DELAY_MS = 3000;
const GAS_MULTIPLIER = 1.3;

// ================= POLYGON CONSTANTS =================
const RPC = "https://polygon-rpc.com";

const USDCe  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH   = "0x172370d5cd63279efa6d502dab29171933a610af";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WBTC   = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";

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

// ================= MULTI-HOP ROUTES =================
// BUY PATHS must start with USDC
// SELL PATHS must end with USDC
const ROUTES = [
  {
    name: "USDC → WETH → USDC",
    buy:  [USDCe, WETH],
    sell: [WETH, USDCe],
    midToken: WETH
  },
  {
    name: "USDC → WMATIC → USDC",
    buy:  [USDCe, WMATIC],
    sell: [WMATIC, USDCe],
    midToken: WMATIC
  },
  {
    name: "USDC → WMATIC → WETH → USDC",
    buy:  [USDCe, WMATIC, WETH],
    sell: [WETH, WMATIC, USDCe],
    midToken: WETH
  },
  {
    name: "USDC → WBTC → USDC",
    buy:  [USDCe, WBTC],
    sell: [WBTC, USDCe],
    midToken: WBTC
  }
];

// =======================================================
// MAIN LOOP
// =======================================================
async function run() {

  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY missing");
  }

  console.log(cyan(`\n⏱ ${now()}  Polygon Arb Bot Started`));

  const maticBal = await provider.getBalance(wallet.address);
  console.log(`⛽ Wallet MATIC: ${ethers.formatEther(maticBal)}`);

  const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

  while (true) {

    for (const buy of routers) {
      for (const sell of routers) {

        if (buy.addr === sell.addr) continue;

        const buyRouter  = new ethers.Contract(buy.addr, ROUTER_ABI, provider);
        const sellRouter = new ethers.Contract(sell.addr, ROUTER_ABI, provider);

        for (const route of ROUTES) {

          console.log(
            cyan(`\n🔍 ${buy.name} ➜ ${sell.name} | ${route.name}`)
          );

          try {
            const amountIn = ethers.parseUnits(
              TRADE_USDC.toString(),
              6
            );

            // ===== BUY (CHAINED) =====
            const buyQuote = await buyRouter.getAmountsOut(
              amountIn,
              route.buy
            );

            const midAmount = buyQuote[buyQuote.length - 1];

            // ===== SELL (CHAINED) =====
            const sellQuote = await sellRouter.getAmountsOut(
              midAmount,
              route.sell
            );

            const usdcOut = Number(
              ethers.formatUnits(sellQuote[sellQuote.length - 1], 6)
            );

            const profitUSDC = usdcOut - TRADE_USDC;
            const profitPct = pct(usdcOut, TRADE_USDC);

            console.log(`📥 USDC In: ${TRADE_USDC}`);
            console.log(`📤 USDC Out: ${usdcOut.toFixed(6)}`);
            console.log(`💵 Profit: ${profitUSDC.toFixed(6)} (${profitPct.toFixed(3)}%)`);

            if (profitPct < MIN_PROFIT_PCT) {
              console.log(yellow("⚠️ Below minimum profit – skipping"));
              continue;
            }

            console.log(green("💰 PROFITABLE OPPORTUNITY"));

            if (DRY_RUN) {
              console.log(cyan("🧪 DRY RUN – no transaction sent"));
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
              route.midToken,
              amountIn,
              minReturnUSDC,
              { gasPrice }
            );

            console.log(green(`🚀 TX SENT: ${tx.hash}`));
            await tx.wait();
            console.log(green("✅ CONFIRMED"));

          } catch (err) {
            console.log(red("❌ REVERT / NO LIQUIDITY / PROTECTED"));
          }

          await sleep(CHECK_DELAY_MS);
        }
      }
    }
  }
}

run();
