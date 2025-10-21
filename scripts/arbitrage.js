import 'dotenv/config';
import { ethers } from 'ethers';

// ----------------- CONFIG -----------------
const TOKENS = {
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  KLIMA: { address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

const ROUTERS = {
  buyRouter: process.env.BUY_ROUTER,
  sellRouter: process.env.SELL_ROUTER
};

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const AMOUNT_IN = process.env.AMOUNT_IN;
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC; // in USDC.e smallest units
const TOKEN_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ----------------- PROVIDER & WALLET -----------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ----------------- CONTRACT ABI -----------------
const ARB_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
  "function withdrawProfit(address token) external"
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

// ----------------- ROUTER ABI -----------------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

// ----------------- MAIN -----------------
async function main() {
  console.log("🚀 Starting Polygon Arbitrage Bot...");
  console.log("✅ Connected as", wallet.address);
  console.log("💰 Amount in:", AMOUNT_IN, "USDC.e");
  console.log("💵 Minimum profit threshold:", MIN_PROFIT_USDC, "USDC.e\n");

  const buyRouter = new ethers.Contract(ROUTERS.buyRouter, ROUTER_ABI, provider);
  const sellRouter = new ethers.Contract(ROUTERS.sellRouter, ROUTER_ABI, provider);

  for (const [symbol, token] of Object.entries(TOKENS)) {
    try {
      const pathBuy = [TOKEN_USDC, token.address];
      const pathSell = [token.address, TOKEN_USDC];

      const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6); // USDC.e has 6 decimals

      // ----- RAW PRICE FETCH -----
      const amountsOutBuy = await buyRouter.getAmountsOut(amountInParsed, pathBuy);
      const tokenAmount = amountsOutBuy[1];

      const amountsOutSell = await sellRouter.getAmountsOut(tokenAmount, pathSell);
      const usdcOut = amountsOutSell[1];

      // ----- DECIMAL NORMALIZATION -----
      const usdcOutFormatted = ethers.formatUnits(usdcOut, 6);
      const profit = usdcOut - parseFloat(AMOUNT_IN);

      console.log(`🔎 Checking token: ${symbol}`);
      console.log(`💰 Estimated profit: $${profit.toFixed(6)} USDC.e`);

      if (profit >= parseFloat(MIN_PROFIT_USDC)) {
        console.log("💥 Arbitrage profitable! Executing trade...");

        const tx = await arbContract.executeArbitrage(
          ROUTERS.buyRouter,
          ROUTERS.sellRouter,
          token.address,
          amountInParsed
        );

        console.log("📤 Transaction submitted! Hash:", tx.hash);
        await tx.wait();
        console.log("✅ Trade executed!\n");
      } else {
        console.log("⚠️ Profit below threshold, skipping.\n");
      }

    } catch (err) {
      console.log(`⚠️ Error executing arbitrage for ${symbol}:`, err.message, "\n");
    }
  }
}

main()
  .then(() => console.log("🏁 Arbitrage check complete."))
  .catch(err => console.error(err));
