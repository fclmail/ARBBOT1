// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------------
// CONFIG
// -------------------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const AMOUNT_IN = process.env.AMOUNT_IN || "0.0008"; // default small trade
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC || "0.00001";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  [
    "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
    "function withdrawProfit(address token) external",
  ],
  wallet
);

// Example token and router setup (replace with your own)
const tokens = {
  USDC: { address: process.env.USDC_ADDRESS, decimals: 6 },
  WBTC: { address: process.env.WBTC_ADDRESS },
  WETH: { address: process.env.WETH_ADDRESS },
  KLIMA: { address: process.env.KLIMA_ADDRESS },
};

const routers = {
  SUSHI: process.env.SUSHI_ROUTER,
  QUICK: process.env.QUICK_ROUTER,
};

// -------------------------
// HELPERS
// -------------------------
async function getTokenDecimals(tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ["function decimals() view returns (uint8)"], provider);
  return await token.decimals();
}

async function getAmountOutRaw(router, tokenIn, amountIn) {
  const path = [tokens.USDC.address, tokenIn, tokens.USDC.address];
  try {
    const routerContract = new ethers.Contract(
      router,
      ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"],
      provider
    );
    const amounts = await routerContract.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch (e) {
    console.error(`⚠️ getAmountOutRaw failed for ${tokenIn} on router ${router}: ${e.message}`);
    return ethers.BigInt(0);
  }
}

function normalizeAmount(amount, decimals) {
  return Number(ethers.formatUnits(amount, decimals));
}

async function fetchTokenDecimals(tokenObj) {
  if (!tokenObj.decimals) tokenObj.decimals = await getTokenDecimals(tokenObj.address);
}

// -------------------------
// ARBITRAGE LOOP
// -------------------------
let STOP = false;

process.on("SIGINT", () => {
  console.log("\n🛑 Stop signal received. Exiting...");
  STOP = true;
});

async function arbitrageLoop() {
  // Ensure all decimals are loaded
  for (const t of Object.values(tokens)) await fetchTokenDecimals(t);

  console.log("🚀 Starting Polygon Arbitrage Bot...");

  while (!STOP) {
    for (const [symbol, token] of Object.entries(tokens)) {
      if (symbol === "USDC") continue;

      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyName === sellName) continue;

          try {
            const amountInRaw = ethers.parseUnits(AMOUNT_IN.toString(), tokens.USDC.decimals);

            // Fetch raw amounts
            const buyOut = await getAmountOutRaw(buyRouter, token.address, amountInRaw);
            const sellOut = await getAmountOutRaw(sellRouter, token.address, buyOut);

            // Normalize to USDC
            const buyOutNorm = normalizeAmount(buyOut, token.decimals);
            const sellOutNorm = normalizeAmount(sellOut, tokens.USDC.decimals);

            const profit = sellOutNorm - AMOUNT_IN;
            const profitUSDC = profit;

            console.log(`🔎 ${symbol} ${buyName}→${sellName} | Est. Profit: $${profitUSDC.toFixed(6)} USDC`);

            if (profitUSDC >= MIN_PROFIT_USDC) {
              console.log(`⚡ Profitable opportunity found! Executing arbitrage for ${symbol}...`);
              const tx = await contract.executeArbitrage(buyRouter, sellRouter, token.address, amountInRaw, { gasLimit: 1000000 });
              console.log(`📤 Transaction sent: ${tx.hash}`);
              const receipt = await tx.wait();
              console.log(`✅ Arbitrage executed. Tx confirmed in block ${receipt.blockNumber}. Profit est: $${profitUSDC.toFixed(6)} USDC`);
            }
          } catch (err) {
            console.error(`⚠️ Error executing arbitrage for ${symbol} ${buyName}→${sellName}: ${err.message}`);
          }
        }
      }
    }

    // Optional: small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("🛑 Arbitrage loop stopped.");
}

// -------------------------
// START
// -------------------------
arbitrageLoop().catch((err) => console.error(err));
