#!/usr/bin/env node
/**
 * scripts/arbitrage.js
 * Live arbitrage scanner + executor using on-chain getAmountsOut (UniswapV2-style routers).
 *
 * Required env:
 *  - RPC_URL
 *  - PRIVATE_KEY
 *  - BUY_ROUTER
 *  - SELL_ROUTER
 *  - TOKEN          (token to arbitrage, e.g. some token)
 *  - AMOUNT_IN_HUMAN (amount in USDC human units, e.g. "100")
 *
 * Optional env:
 *  - CONTRACT_ADDRESS (defaults to 0x19B64f74553eE0ee26BA01BF34321735E4701C43)
 *  - MIN_PROFIT_USDC (defaults to 0.0000001)
 *  - SCAN_INTERVAL_MS (defaults to 5000)
 *
 * Important: routers must support getAmountsOut (UniswapV2-style).
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

const {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN,
  CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
  MIN_PROFIT_USDC,
  SCAN_INTERVAL_MS
} = process.env;

if (!RPC_URL || !PRIVATE_KEY || !BUY_ROUTER || !SELL_ROUTER || !TOKEN || !AMOUNT_IN_HUMAN) {
  console.error("Missing required environment variables! Required: RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, AMOUNT_IN_HUMAN");
  process.exit(1);
}

// Config / defaults
const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
const buyRouterAddr = BUY_ROUTER.trim();
const sellRouterAddr = SELL_ROUTER.trim();
const tokenAddr = TOKEN.trim();
const rpcUrl = RPC_URL.trim();
const AMOUNT_HUMAN = AMOUNT_IN_HUMAN.trim();
const DECIMALS = 6; // USDC-like token decimals used for amount parsing/formatting
const MIN_PROFIT = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

// Validate addresses
for (const [name, a] of [
  ["BUY_ROUTER", buyRouterAddr],
  ["SELL_ROUTER", sellRouterAddr],
  ["TOKEN", tokenAddr],
  ["CONTRACT_ADDRESS", CONTRACT_ADDRESS]
]) {
  if (!isAddress(a)) {
    console.error(`❌ Invalid Ethereum address for ${name}:`, a);
    process.exit(1);
  }
}

// Provider / wallet / contract
const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

// Minimal UniswapV2-style router ABI (getAmountsOut)
const UNIV2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

// Minimal arb contract ABI (executeArbitrage)
const ARB_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
  // withdrawProfit left out on purpose (we keep profits in contract)
];

// Router contract instances
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);

// Arb contract instance (needs signer to send tx)
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

// Helpers
const toUnits = (humanStr) => parseUnits(humanStr, DECIMALS); // parse human to token smallest units
const fromUnits = (big) => formatUnits(big, DECIMALS); // format units to human string
const minProfitUnits = toUnits(String(MIN_PROFIT));
const amountIn = toUnits(AMOUNT_HUMAN);

// utility timestamp
function now() {
  return new Date().toISOString();
}

// Main loop
console.log(`${now()} ▸ Starting live arbitrage scanner`);
console.log(`${now()} ▸ Config: contract=${CONTRACT_ADDRESS}, buyRouter=${buyRouterAddr}, sellRouter=${sellRouterAddr}, token=${tokenAddr}, amountIn=${AMOUNT_HUMAN}, minProfit=${MIN_PROFIT}`);

let iteration = 0;

async function scanOnce() {
  iteration += 1;
  try {
    // 1) getAmountsOut on buy router (USDC -> token)
    const pathBuy = [ /* USDC */ tokenAddr === undefined ? null : null ]; // placeholder, we'll set below
    // For this script we assume token is token and base is USDC; if token is USDC you'd normally swap between USDC & WETH or pair — but we will assume path [USDC, token]
    // The user must set TOKEN to the non-USDC token; amountIn is USDC.
    // We'll use path = [USDC, token]. But we need the USDC address. Since contract uses USDC as loan asset, we assume TOKEN is token and base is USDC.
    // To handle this, require user to provide USDC address in env? Simpler: treat TOKEN as non-USDC token and AMOUNT_IN_HUMAN is USDC. So base token address must be known.
    // We'll assume USDC address is the token used as input — if TOKEN is USDC this won't make sense. To be explicit, require USDC address via env variable USDC_ADDRESS.
  } catch (err) {
    // placeholder
  }
}

// Because the above ambiguity about USDC base vs TOKEN is critical, we must require explicit USDC address.
// Update: require USDC_ADDRESS in env

const { USDC_ADDRESS } = process.env;
if (!USDC_ADDRESS) {
  console.error("Missing USDC_ADDRESS environment variable (address of USDC on chain). Add as repo secret USDC_ADDRESS.");
  process.exit(1);
}
const usdcAddr = USDC_ADDRESS.trim();
if (!isAddress(usdcAddr)) {
  console.error("Invalid USDC_ADDRESS:", usdcAddr);
  process.exit(1);
}

// Now implement the actual loop
async function runLoop() {
  while (true) {
    iteration++;
    try {
      const block = await provider.getBlockNumber();
      console.log(`${now()} [#${iteration}] block=${block} — scanning...`);

      // Build paths: USDC -> token (buy), token -> USDC (sell)
      const pathBuy = [usdcAddr, tokenAddr];
      const pathSell = [tokenAddr, usdcAddr];

      // 1) getAmountsOut on buy router
      let buyAmounts;
      try {
        buyAmounts = await buyRouter.getAmountsOut(amountIn, pathBuy);
      } catch (err) {
        console.warn(`${now()} [#${iteration}] getAmountsOut failed on buyRouter:`, err.message || err);
        await sleep(SCAN_MS);
        continue;
      }

      const buyOut = buyAmounts[buyAmounts.length - 1]; // token amount received after buy
      // 2) getAmountsOut on sell router for selling buyOut back to USDC
      let sellAmounts;
      try {
        sellAmounts = await sellRouter.getAmountsOut(buyOut, pathSell);
      } catch (err) {
        console.warn(`${now()} [#${iteration}] getAmountsOut failed on sellRouter:`, err.message || err);
        await sleep(SCAN_MS);
        continue;
      }

      const sellOut = sellAmounts[sellAmounts.length - 1]; // USDC amount received after selling token

      // Compute profit = sellOut - amountIn (both BigInt-like)
      const profit = sellOut - amountIn;

      // Log amounts (raw and human readable)
      console.log(`${now()} [#${iteration}] buyAmount(token) = ${buyOut.toString()} (${fromUnits(buyOut)} token units)`);
      console.log(`${now()} [#${iteration}] sellAmount(USDC) = ${sellOut.toString()} (${fromUnits(sellOut)} USDC)`);
      console.log(`${now()} [#${iteration}] invested USDC = ${amountIn.toString()} (${fromUnits(amountIn)} USDC)`);
      console.log(`${now()} [#${iteration}] raw profit = ${profit.toString()} (${fromUnits(profit)} USDC)`);

      // If profit > 0 (raw) then execute arbitrage
      if (profit > 0n) {
        console.log(`${now()} [#${iteration}] Profit positive — attempting executeArbitrage...`);

        try {
          // estimateGas first (safe check)
          const gasEst = await arbContract.estimateGas.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn);
          console.log(`${now()} [#${iteration}] gas estimate: ${gasEst.toString()}`);

          const tx = await arbContract.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn, { gasLimit: gasEst.mul(110).div(100) }); // add 10% buffer
          console.log(`${now()} [#${iteration}] tx sent: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${now()} [#${iteration}] tx confirmed: ${receipt.transactionHash}`);
          console.log(`${now()} [#${iteration}] Arbitrage executed — profit (raw) was ${fromUnits(profit)} USDC — profit remains in contract balance.`);

        } catch (err) {
          console.error(`${now()} [#${iteration}] Execution reverted or failed:`, err);
        }
      } else {
        console.log(`${now()} [#${iteration}] No positive profit (<= 0). Skipping execution.`);
      }

    } catch (err) {
      console.error(`${now()} [#${iteration}] Unexpected error in loop:`, err);
    }

    await sleep(SCAN_MS);
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Start
runLoop().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});

