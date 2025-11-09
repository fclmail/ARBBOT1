//────────────────────────────────────────────
//  arbitrage.js — Full Automated Arbitrage Bot
//────────────────────────────────────────────

//🟢1  Import required libraries and environment configuration
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

//🟢2  Load environment variables: RPC URL and wallet private key
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env file");

//🟢3  Set up Ethers.js provider and wallet (connected to Polygon)
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

//🟢4  Address of deployed arbitrage smart contract
const CONTRACT_ADDRESS = "0x19b64f74553ee0ee26ba01bf34321735e4701c43";

//🟢5  Create contract instance to interact with executeArbitrage()
const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  [
    "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
  ],
  wallet
);

//────────────────────────────────────────────
//🟢6  Router addresses (EIP-55 checksummed)
//────────────────────────────────────────────
const routers = {
  QuickSwap: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
  SushiSwap: ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
  Dfyn:      ethers.getAddress("0xa8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73"),
  ApeSwap:   ethers.getAddress("0xC0788A3aD43d79AA53B09c2EaCc313A787d1d607")
};

//────────────────────────────────────────────
//🟢7  Token list with correct addresses & decimals
//────────────────────────────────────────────
const tokens = {
  USDC: { address: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"), decimals: 6 },
  USDT: { address: ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F"), decimals: 6 },
  WETH: { address: ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"), decimals: 18 },
  AAVE: { address: ethers.getAddress("0xd6DF932A45C0f255f85145F286EA0b292B21C90B"), decimals: 18 }
};

//────────────────────────────────────────────
//🟢8  Trade parameters and thresholds
//────────────────────────────────────────────
const TRADE_AMOUNT_USDC = 10;    // Base trade amount (in USDC)
const MIN_PROFIT_PCT = 0.2;      // Minimum profit percentage to execute
const SLIPPAGE_PCT = 0.0;        // Slippage tolerance
const SCAN_DELAY_MS = 3000;      // Time between scans (3 seconds)

//────────────────────────────────────────────
//🟢9  Helper: Format number to decimals
function fmt(n, dec = 6) {
  return Number(n).toFixed(dec);
}

//────────────────────────────────────────────
//🟢10  Helper: Get output token amount from a DEX router
//────────────────────────────────────────────
async function getAmountOut(routerAddr, token, amountIn) {
  try {
    const router = new ethers.Contract(
      routerAddr,
      ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
      provider
    );

    const path = [tokens.USDC.address, token.address];
    try {
      const amounts = await router.getAmountsOut(
        ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
        path
      );
      return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
    } catch {
      // Fallback via WETH
      const path2 = [tokens.USDC.address, tokens.WETH.address, token.address];
      const amounts = await router.getAmountsOut(
        ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
        path2
      );
      return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
    }
  } catch (err) {
    console.warn(`⚠️ getAmountOut failed for router ${routerAddr}: ${err.message}`);
    return 0; // Continue scanning next pair
  }
}

//────────────────────────────────────────────
//🟢11  Core Scanner — checks all router pairs for arbitrage
//────────────────────────────────────────────
async function scan() {
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue; // Skip identical routes

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          if (!buyOut || !sellOut) continue; // Skip failed pairs

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          // Apply slippage adjustment
          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ token: symbol, buyName, sellName, buyPrice, sellPrice, profitUSDC, profitPct });
            console.log(
              `🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: $${fmt(profitUSDC)} (${fmt(profitPct, 2)}%)`
            );

            // Execute the arbitrage trade automatically
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn(`⚠️ Scan error ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`✅ Scan complete. Found ${opportunities.length} opportunities.`);
  return opportunities;
}

//────────────────────────────────────────────
//🟢12  Executes arbitrage on-chain through your deployed contract
//────────────────────────────────────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), tokens.USDC.decimals),
      { gasLimit: 2_000_000 }
    );

    console.log(`⛽ Transaction sent: ${tx.hash}`);
    await tx.wait();
    console.log("✅ Trade executed successfully.");
  } catch (e) {
    console.error(`⚠️ Trade failed: ${e.reason || e.message}`);
  }
}

//────────────────────────────────────────────
//🟢13  Main execution loop — repeats scanning indefinitely
//────────────────────────────────────────────
async function main() {
  console.log("🚀 Arbitrage bot started...");
  console.log("💰 Ensure USDC is approved for the arbitrage contract before running!");
  console.log("-------------------------------------------------------------");

  while (true) {
    await scan();
    await new Promise((r) => setTimeout(r, SCAN_DELAY_MS));
  }
}

//────────────────────────────────────────────
//🟢14  Start the bot and catch any unexpected errors
main().catch((err) => console.error("❌ Fatal error:", err.message));

  
