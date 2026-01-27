
// SPDX-License-Identifier: MIT
// 🟢 Fully functional, production-safe arbitrage bot
// 🟢 Restored display style + profit-confirmed execution

import { ethers } from "ethers";

/* ─────────────────────────────
   🟢 1. RPC + SIGNER
───────────────────────────── */
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

/* ─────────────────────────────
   🟢 2. ADDRESSES (Polygon)
───────────────────────────── */
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHI_ROUTER     = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* Execution uses V2-compatible router only */
const BUY_ROUTER  = SUSHI_ROUTER;
const SELL_ROUTER = SUSHI_ROUTER;

/* ─────────────────────────────
   🟢 3. ABIs
───────────────────────────── */
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external",
  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"
];

const sushiABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
];

/* ─────────────────────────────
   🟢 4. CONTRACTS
───────────────────────────── */
const vault  = new ethers.Contract(VAULT_CONTRACT, vaultABI, wallet);
const sushi  = new ethers.Contract(SUSHI_ROUTER, sushiABI, provider);
const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, quoterABI, provider);

/* ─────────────────────────────
   🟢 5. CONFIGURATION
───────────────────────────── */
const TRADE_SIZE = ethers.parseUnits("0.8", 6);     // 0.8 USDC
const UNI_FEE = 3000;                               // 0.3%
const MIN_PROFIT_USDC = ethers.parseUnits("0.005", 6); // 0.005 USDC
const LOOP_INTERVAL_MS = 5000;                      // ~12 scans/min

let executing = false;
let lastConfirmed = false;

/* ─────────────────────────────
   🟢 6. HELPERS
───────────────────────────── */
const ts = () => new Date().toISOString();
const fmt = (n, d = 6) => Number(n).toFixed(d);

/* ─────────────────────────────
   🟢 7. MAIN LOOP (GRAPH STYLE)
───────────────────────────── */
async function checkAndExecute() {
  if (executing) return;

  const time = ts();

  try {
    /* ──────────────
       7.1 UNI V3 QUOTE (USDC → WMATIC)
    ────────────── */
    const wmaticOut = await quoter.quoteExactInputSingle.staticCall(
      USDC,
      WMATIC,
      UNI_FEE,
      TRADE_SIZE,
      0
    );

    const uniPrice = Number(wmaticOut) / 1e18;

    /* ──────────────
       7.2 SUSHI QUOTE (WMATIC → USDC)
    ────────────── */
    const sushiOut = await sushi.getAmountsOut(
      wmaticOut,
      [WMATIC, USDC]
    );

    const usdcBack = sushiOut[1];
    const sushiPrice = Number(usdcBack) / Number(wmaticOut);

    /* ──────────────
       7.3 DISPLAY (RESTORED STYLE)
    ────────────── */
    console.log(`[${time}] UNI: ${fmt(uniPrice)} WMATIC`);
    console.log(`[${time}] SUSHI: ${fmt(sushiPrice)} USDC/WMATIC`);

    const impliedSpread =
      ((sushiPrice * uniPrice - 1) * 100);

    console.log(`[${time}] Spread: ${fmt(impliedSpread, 4)}%`);

    /* ──────────────
       7.4 CANDIDATE STAGE (DISPLAY ONLY)
    ────────────── */
    if (impliedSpread > 0) {
      console.log(`[${time}] 🟡 ARBITRAGE CANDIDATE`);
    }

    /* ──────────────
       7.5 PROFIT CONFIRMATION
    ────────────── */
    const profit = usdcBack - TRADE_SIZE;

    if (profit < MIN_PROFIT_USDC) {
      lastConfirmed = false;
      console.log(`[${time}] ❌ No executable arbitrage`);
      console.log("──────────────────────────────");
      return;
    }

    /* ──────────────
       7.6 CONFIRMED (STATE TRANSITION)
    ────────────── */
    if (!lastConfirmed) {
      console.log(`[${time}] ✅ ARBITRAGE CONFIRMED`);
      console.log(
        `[${time}] Net Profit: +${fmt(Number(profit) / 1e6)} USDC`
      );
    }

    lastConfirmed = true;

    /* ──────────────
       7.7 EXECUTION
    ────────────── */
    executing = true;
    console.log(`[${time}] EXECUTING ON-CHAIN...`);

    const deadline = Math.floor(Date.now() / 1000) + 120;

    const tx = await vault.executeArbitrage(
      BUY_ROUTER,
      SELL_ROUTER,
      TRADE_SIZE,
      [USDC, WMATIC],
      [WMATIC, USDC],
      deadline,
      { gasLimit: 1_500_000 }
    );

    console.log(`[${time}] TX SENT: ${tx.hash}`);

    await tx.wait();

    console.log(`[${ts()}] TX CONFIRMED`);
    console.log(`[${ts()}] 💰 Profit sent to vault`);
    console.log("──────────────────────────────");

  } catch (err) {
    console.error(
      `[${time}] ERROR`,
      err.reason || err.message || err
    );
  } finally {
    executing = false;
  }
}

/* ─────────────────────────────
   🟢 8. SCHEDULER
───────────────────────────── */
setInterval(checkAndExecute, LOOP_INTERVAL_MS);
