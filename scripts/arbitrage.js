import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/* ─────────────────────────────
   Provider & Wallet
───────────────────────────── */
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

/* ─────────────────────────────
   Addresses (Polygon)
───────────────────────────── */
const VAULT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ─────────────────────────────
   ABIs
───────────────────────────── */
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
];

const routerABI = [
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
];

/* ─────────────────────────────
   Contracts
───────────────────────────── */
const vault = new ethers.Contract(VAULT, vaultABI, wallet);
const sushi = new ethers.Contract(SUSHI_ROUTER, routerABI, provider);

/* ─────────────────────────────
   Config
───────────────────────────── */
const TRADE_SIZE = ethers.parseUnits("800", 6); // 800 USDC
const SLIPPAGE_BPS = 50n; // 0.5%
const LOOP_INTERVAL_MS = 6000; // ~10 tx/min max
const GAS_LIMIT = 1_000_000n;

/* ─────────────────────────────
   State
───────────────────────────── */
let nextNonce;
let txInFlight = false;

/* ─────────────────────────────
   Helpers
───────────────────────────── */
function applySlippage(amount, bps) {
  return amount - (amount * bps) / 10_000n;
}

/* ─────────────────────────────
   Main Arbitrage Logic
───────────────────────────── */
async function checkAndExecute() {
  if (txInFlight) return;

  const ts = new Date().toISOString();

  try {
    /* ── Quotes (BOTH legs, same router) ── */
    const out1 = await sushi.getAmountsOut(
      TRADE_SIZE,
      [USDC, WMATIC]
    );

    const tokenOut = out1[1];

    const out2 = await sushi.getAmountsOut(
      tokenOut,
      [WMATIC, USDC]
    );

    const usdcBack = out2[1];

    /* ── Slippage protection ── */
    const minTokenOut = applySlippage(tokenOut, SLIPPAGE_BPS);
    const minUSDCOut = applySlippage(usdcBack, SLIPPAGE_BPS);

    if (minUSDCOut <= TRADE_SIZE) {
      console.log(`[${ts}] ❌ No real profit`);
      return;
    }

    /* ── Dry run (NO GAS WASTE) ── */
    try {
      await vault.executeArbitrage.staticCall(
        SUSHI_ROUTER,
        SUSHI_ROUTER,
        TRADE_SIZE,
        [USDC, WMATIC],
        [WMATIC, USDC],
        Math.floor(Date.now() / 1000) + 120
      );
    } catch {
      console.log(`[${ts}] ❌ Would revert (static)`);
      return;
    }

    /* ── Execute on-chain ── */
    txInFlight = true;

    const tx = await vault.executeArbitrage(
      SUSHI_ROUTER,
      SUSHI_ROUTER,
      TRADE_SIZE,
      [USDC, WMATIC],
      [WMATIC, USDC],
      Math.floor(Date.now() / 1000) + 120,
      {
        nonce: nextNonce,
        gasLimit: GAS_LIMIT,
      }
    );

    console.log(`[${ts}] 🚀 TX SENT: ${tx.hash}`);
    nextNonce++;

    await tx.wait(1);
    console.log(`[${ts}] ✅ TX CONFIRMED`);

  } catch (err) {
    console.error(`[${ts}] ERROR`, err.reason || err.message);
  } finally {
    txInFlight = false;
  }
}

/* ─────────────────────────────
   Init
───────────────────────────── */
async function start() {
  nextNonce = await wallet.getNonce("latest");
  console.log("Bot started. Nonce:", nextNonce);

  setInterval(checkAndExecute, LOOP_INTERVAL_MS);
}

start();
   
