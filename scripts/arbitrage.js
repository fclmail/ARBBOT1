import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ------------------------
// Environment variables
// ------------------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const AMOUNT_IN = process.env.AMOUNT_IN || "100"; // default 100 USDC.e
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC || "0.00001";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Arbitrage contract ABI snippet (executeArbitrage + withdrawProfit)
const contractAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function withdrawProfit(address token) external",
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

// Example tokens and routers (update with your actual addresses)
const tokens = {
  USDC: { address: process.env.USDC_ADDRESS, decimals: 6 },
  WETH: { address: process.env.WETH_ADDRESS },
  WBTC: { address: process.env.WBTC_ADDRESS },
  KLIMA: { address: process.env.KLIMA_ADDRESS },
  DAI: { address: process.env.DAI_ADDRESS },
  LINK: { address: process.env.LINK_ADDRESS },
  QUICK: { address: process.env.QUICK_ADDRESS },
  CRV: { address: process.env.CRV_ADDRESS },
  USDT: { address: process.env.USDT_ADDRESS },
};

const routers = {
  BUY: process.env.BUY_ROUTER,
  SELL: process.env.SELL_ROUTER,
};

// ------------------------
// Stop mechanism
// ------------------------
let stopFlag = false;
process.on("SIGINT", () => {
  console.log("\n🛑 Stop signal received. Exiting...");
  stopFlag = true;
});

// ------------------------
// Helpers
// ------------------------
async function getTokenDecimals(tokenAddress) {
  const tokenContract = new ethers.Contract(
    tokenAddress,
    ["function decimals() view returns (uint8)"],
    provider
  );
  return await tokenContract.decimals();
}

async function getAmountOut(routerAddress, tokenAddress, amountInRaw) {
  try {
    const router = new ethers.Contract(
      routerAddress,
      [
        "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
      ],
      provider
    );

    const path = [tokens.USDC.address, tokenAddress];
    const amountsOut = await router.getAmountsOut(amountInRaw, path);
    return amountsOut[1]; // token amount received
  } catch (err) {
    console.warn(`⚠️ getAmountOut failed: ${err.message}`);
    return null;
  }
}

// ------------------------
// Main arbitrage loop
// ------------------------
async function arbitrageLoop() {
  console.log("🚀 Starting Polygon Arbitrage Bot...");
  console.log(`💰 Amount in: ${AMOUNT_IN} USDC.e`);
  console.log(`💵 Minimum profit threshold: ${MIN_PROFIT_USDC} USDC.e`);

  const usdcDecimals = tokens.USDC.decimals || (await getTokenDecimals(tokens.USDC.address));
  const amountInRaw = ethers.utils.parseUnits(AMOUNT_IN.toString(), usdcDecimals);

  while (!stopFlag) {
    for (const [symbol, meta] of Object.entries(tokens)) {
      if (symbol === "USDC") continue; // skip base token

      const tokenDecimals = meta.decimals || (await getTokenDecimals(meta.address));
      try {
        // RAW amounts out
        const buyOutRaw = await getAmountOut(routers.BUY, meta.address, amountInRaw);
        const sellOutRaw = await getAmountOut(routers.SELL, meta.address, amountInRaw);

        if (!buyOutRaw || !sellOutRaw) continue;

        const buyAmount = Number(ethers.utils.formatUnits(buyOutRaw, tokenDecimals));
        const sellAmount = Number(ethers.utils.formatUnits(sellOutRaw, tokenDecimals));

        // Profit in USDC
        const profitUSDC = sellAmount - buyAmount;

        console.log(`🔎 Checking token: ${symbol}`);
        console.log(`💰 Estimated profit: $${profitUSDC.toFixed(6)} USDC.e`);

        if (profitUSDC < parseFloat(MIN_PROFIT_USDC)) {
          console.log("⚠️ Profit below threshold, skipping.");
          continue;
        }

        // Execute arbitrage
        console.log(`⚡ Executing arbitrage for ${symbol}...`);
        const tx = await contract.executeArbitrage(
          routers.BUY,
          routers.SELL,
          meta.address,
          amountInRaw,
          { gasLimit: 1000000 }
        );
        console.log(`Transaction sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`✅ Arbitrage done! Gas used: ${receipt.gasUsed.toString()}`);

      } catch (err) {
        console.log(`⚠️ Error executing arbitrage for ${symbol}: ${err.message}`);
      }
    }

    // Sleep 2 seconds between loops
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log("🛑 Arbitrage loop stopped.");
}

// ------------------------
// Start bot
// ------------------------
arbitrageLoop().catch((err) => console.error(err));
