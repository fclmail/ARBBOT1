import { ethers } from "ethers";

/* ─────────────────────────────
   Polygon Mainnet RPC
───────────────────────────── */
const RPC = "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC);

/* ─────────────────────────────
   Vault (provided by you)
───────────────────────────── */
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

/* ─────────────────────────────
   Token Addresses (Polygon)
───────────────────────────── */
const TOKENS = {
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

/* ─────────────────────────────
   DEX Routers
───────────────────────────── */
const DEX = {
  UNISWAP_V3_ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  SUSHISWAP_ROUTER: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

/* ─────────────────────────────
   Minimal ABI for price quoting
───────────────────────────── */
const routerABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)"
];

const uni = new ethers.Contract(DEX.UNISWAP_V3_ROUTER, routerABI, provider);
const sushi = new ethers.Contract(DEX.SUSHISWAP_ROUTER, routerABI, provider);

/* ─────────────────────────────
   Config
───────────────────────────── */
const TRADE_SIZE = ethers.parseUnits("1000", 6); // 1000 USDC
const GAS_ESTIMATE_USD = 0.25;

/* ─────────────────────────────
   Main Loop
───────────────────────────── */
async function checkArb() {
  const timestamp = new Date().toISOString();

  try {
    const path = [TOKENS.USDC, TOKENS.WMATIC];

    const uniOut = await uni.getAmountsOut(TRADE_SIZE, path);
    const sushiOut = await sushi.getAmountsOut(TRADE_SIZE, path);

    const uniPrice = Number(uniOut[1]) / 1e18;
    const sushiPrice = Number(sushiOut[1]) / 1e18;

    const spread = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`[${timestamp}] INFO  Vault: ${VAULT_ADDRESS}`);
    console.log(`[${timestamp}] INFO  Uniswap WMATIC: ${uniPrice.toFixed(6)}`);
    console.log(`[${timestamp}] INFO  SushiSwap WMATIC: ${sushiPrice.toFixed(6)}`);
    console.log(`[${timestamp}] INFO  Spread: ${spread.toFixed(3)}%`);
    console.log(`[${timestamp}] INFO  Estimated Gas: $${GAS_ESTIMATE_USD}`);

    if (spread > 0.3) {
      console.log(`[${timestamp}] ✅ ARBITRAGE SIGNAL`);
      console.log(`  BUY on Uniswap`);
      console.log(`  SELL on SushiSwap`);
      console.log(`  ROUTE PROFIT → Vault ${VAULT_ADDRESS}`);
    } else {
      console.log(`[${timestamp}] ❌ No profitable opportunity`);
    }

    console.log("──────────────────────────────");

  } catch (err) {
    console.error(`[${timestamp}] ERROR`, err.message);
  }
}

/* ─────────────────────────────
   Run every 5 seconds
───────────────────────────── */
setInterval(checkArb, 5000);
