import { ethers } from "ethers";

/* ─────────────────────────────
   Polygon RPC (read-only)
───────────────────────────── */
const RPC = "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC);

/* ─────────────────────────────
   Vault
───────────────────────────── */
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

/* ─────────────────────────────
   Tokens (Polygon)
───────────────────────────── */
const TOKENS = {
  USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ─────────────────────────────
   DEX Addresses
───────────────────────────── */
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const UNI_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

/* ─────────────────────────────
   ABIs
───────────────────────────── */
const sushiABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const quoterABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"
];

/* ─────────────────────────────
   Contracts
───────────────────────────── */
const sushi = new ethers.Contract(SUSHI_ROUTER, sushiABI, provider);
const quoter = new ethers.Contract(UNI_V3_QUOTER, quoterABI, provider);

/* ─────────────────────────────
   Config
───────────────────────────── */
const TRADE_SIZE = ethers.parseUnits("1000", 6); // 1000 USDC
const UNI_FEE_TIER = 3000; // 0.3%
const GAS_ESTIMATE_USD = 0.25;
const MIN_SPREAD = 0.3;

/* ─────────────────────────────
   Main Loop
───────────────────────────── */
async function checkArb() {
  const ts = new Date().toISOString();

  try {
    /* ── SushiSwap V2 quote ── */
    const sushiPath = [TOKENS.USDC, TOKENS.WMATIC];
    const sushiOut = await sushi.getAmountsOut(TRADE_SIZE, sushiPath);
    const sushiWMATIC = Number(sushiOut[1]) / 1e18;

    /* ── Uniswap V3 quote (STATIC CALL) ── */
    const uniOut = await quoter.quoteExactInputSingle.staticCall(
      TOKENS.USDC,
      TOKENS.WMATIC,
      UNI_FEE_TIER,
      TRADE_SIZE,
      0
    );
    const uniWMATIC = Number(uniOut) / 1e18;

    const spread = ((sushiWMATIC - uniWMATIC) / uniWMATIC) * 100;

    console.log(`[${ts}] INFO  Vault: ${VAULT_ADDRESS}`);
    console.log(`[${ts}] INFO  UniswapV3 WMATIC: ${uniWMATIC.toFixed(6)}`);
    console.log(`[${ts}] INFO  SushiSwap WMATIC: ${sushiWMATIC.toFixed(6)}`);
    console.log(`[${ts}] INFO  Spread: ${spread.toFixed(3)}%`);
    console.log(`[${ts}] INFO  Est Gas: $${GAS_ESTIMATE_USD}`);

    if (spread >= MIN_SPREAD) {
      console.log(`[${ts}] ✅ ARBITRAGE SIGNAL`);
      console.log(`  BUY  → Uniswap V3`);
      console.log(`  SELL → SushiSwap`);
      console.log(`  ROUTE → Vault ${VAULT_ADDRESS}`);
    } else {
      console.log(`[${ts}] ❌ No profitable opportunity`);
    }

    console.log("──────────────────────────────");

  } catch (err) {
    console.error(`[${ts}] ERROR`, err.reason || err.message);
  }
}

/* ─────────────────────────────
   Poll every 5 seconds
───────────────────────────── */
setInterval(checkArb, 5000);
