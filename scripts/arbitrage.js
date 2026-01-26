import { ethers } from "ethers";

/* ─────────────────────────────
   Polygon Mainnet RPC
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
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

/* ─────────────────────────────
   Routers / Quoters
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
const GAS_ESTIMATE_USD = 0.25;
const UNI_FEE_TIER = 3000; // 0.3%

/* ─────────────────────────────
   Main Loop
───────────────────────────── */
async function checkArb() {
  const ts = new Date().toISOString();

  try {
    /* SushiSwap (V2) */
    const sushiPath = [TOKENS.USDC, TOKENS.WMATIC];
    const sushiOut = await sushi.getAmountsOut(TRADE_SIZE, sushiPath);
    const sushiPrice = Number(sushiOut[1]) / 1e18;

    /* Uniswap V3 (Quoter) */
    const uniOut = await quoter.quoteExactInputSingle(
      TOKENS.USDC,
      TOKENS.WMATIC,
      UNI_FEE_TIER,
      TRADE_SIZE,
      0
    );
    const uniPrice = Number(uniOut) / 1e18;

    const spread = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`[${ts}] INFO  Vault: ${VAULT_ADDRESS}`);
    console.log(`[${ts}] INFO  UniswapV3 WMATIC: ${uniPrice.toFixed(6)}`);
    console.log(`[${ts}] INFO  SushiSwap WMATIC: ${sushiPrice.toFixed(6)}`);
    console.log(`[${ts}] INFO  Spread: ${spread.toFixed(3)}%`);
    console.log(`[${ts}] INFO  Est Gas: $${GAS_ESTIMATE_USD}`);

    if (spread > 0.3) {
      console.log(`[${ts}] ✅ ARBITRAGE SIGNAL`);
      console.log(`  BUY  → Uniswap V3`);
      console.log(`  SELL → SushiSwap`);
      console.log(`  PROFIT ROUTED → ${VAULT_ADDRESS}`);
    } else {
      console.log(`[${ts}] ❌ No profitable opportunity`);
    }

    console.log("──────────────────────────────");

  } catch (err) {
    console.error(`[${ts}] ERROR`, err.reason || err.message);
  }
}

/* ─────────────────────────────
   Run every 5 seconds
───────────────────────────── */
setInterval(checkArb, 5000);
