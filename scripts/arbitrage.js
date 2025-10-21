import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const AMOUNT_IN_USDC = process.env.AMOUNT_IN; // e.g., "100"
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC; // e.g., "0.00001"
const BUY_ROUTER = process.env.BUY_ROUTER;
const SELL_ROUTER = process.env.SELL_ROUTER;
const TOKEN_LIST = JSON.parse(process.env.TOKEN_LIST); 
// Example: { "WETH": { "address": "0x...", "decimals": 18 }, "WBTC": {...} }

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  ["function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
   "function withdrawProfit(address token) external"],
  wallet
);

// ------------------------
// UTILITIES
// ------------------------

async function getTokenDecimals(tokenAddress) {
  if (!tokenAddress) return 18; // fallback
  const token = new ethers.Contract(tokenAddress, ["function decimals() view returns (uint8)"], provider);
  return await token.decimals();
}

async function getAmountOut(routerAddress, tokenIn, amountInRaw) {
  if (!tokenIn || !routerAddress) return ethers.BigInt(0);
  try {
    const router = new ethers.Contract(routerAddress,
      ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"],
      provider
    );
    const amounts = await router.getAmountsOut(amountInRaw, [TOKEN_LIST.USDC.address, tokenIn]);
    return amounts[1];
  } catch (e) {
    console.warn(`⚠️ getAmountOut failed for token ${tokenIn}: ${e.message}`);
    return ethers.BigInt(0);
  }
}

// ------------------------
// ARBITRAGE LOOP
// ------------------------

let stopBot = false;

process.on("SIGINT", () => {
  console.log("🛑 Stop signal received. Exiting loop...");
  stopBot = true;
});

async function arbitrageLoop() {
  console.log("🚀 Starting Polygon Arbitrage Bot...");
  console.log(`💰 Amount in: ${AMOUNT_IN_USDC} USDC.e`);
  console.log(`💵 Minimum profit threshold: ${MIN_PROFIT_USDC} USDC.e`);

  while (!stopBot) {
    for (const [symbol, token] of Object.entries(TOKEN_LIST)) {
      if (!token.address || symbol === "USDC") continue;

      try {
        const decimals = token.decimals || await getTokenDecimals(token.address);
        const amountInRaw = ethers.parseUnits(AMOUNT_IN_USDC, 6); // USDC 6 decimals

        // Raw getAmountOut for buy and sell
        const buyAmountOut = await getAmountOut(BUY_ROUTER, token.address, amountInRaw);
        const sellAmountOut = await getAmountOut(SELL_ROUTER, token.address, buyAmountOut);

        // Decimal normalization
        const buyNormalized = Number(buyAmountOut) / (10 ** decimals);
        const sellNormalized = Number(sellAmountOut) / (10 ** 6); // USDC output

        const profit = sellNormalized - Number(AMOUNT_IN_USDC);
        console.log(`🔎 ${symbol} | Estimated profit: $${profit.toFixed(8)} USDC.e`);

        if (profit >= Number(MIN_PROFIT_USDC)) {
          console.log(`⚡ Profit above threshold. Executing arbitrage for ${symbol}...`);
          const tx = await contract.executeArbitrage(BUY_ROUTER, SELL_ROUTER, token.address, amountInRaw, { gasLimit: 1_000_000 });
          console.log(`✅ Tx sent: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`🎯 Arbitrage executed: ${symbol} | Block: ${receipt.blockNumber}`);
        } else {
          console.log(`⚠️ Profit below threshold, skipping ${symbol}`);
        }

      } catch (e) {
        console.error(`⚠️ Error executing arbitrage for ${symbol}: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 2000)); // 2s pause before next scan
  }

  console.log("🛑 Bot stopped. Exiting.");
}

// ------------------------
// START
// ------------------------

arbitrageLoop().catch(console.error);
