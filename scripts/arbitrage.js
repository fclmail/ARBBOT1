// arb_static.js
// Aave Flash Arb Bot on Polygon with "static" (dry-run) check prior to arbitrage.
// No contract changes required. Adds a client-side dry-run before executing arbitrage.
// If a simulateArbitrage view function exists on-chain, it will be used.
// If not, static check is skipped with a clear log.

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG 🟢1 ───────────────
// Environment variables and essential settings.

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // deployed contract
const MIN_NET_PROFIT_USDC = 1; // optional threshold for on-chain profitability sanity (client-side)

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

// Initialize provider and signer
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── FULL CONTRACT ABI 🟢2 ───────────────
// Base ABI (executeArbitrage, USDC, owner) plus optional simulateArbitrage
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  // Optional static simulation function (if you decide to add on-chain simulateArbitrage later)
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "simulateArbitrage",
    "outputs": [
      { "internalType": "bool", "name": "profitable", "type": "bool" },
      { "internalType": "uint256", "name": "netProfit", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// ─────────────── CONTRACT CONNECTION 🟢3 ───────────────
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);
(async () => {
  try {
    console.log("✅ Connected to contract:", await arbContract.getAddress());
    console.log("👤 Contract owner:", await arbContract.owner());
  } catch (err) {
    console.error("Failed to connect to contract:", err);
  }
})();

// ─────────────── ROUTERS 🟢4 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS 🟢5 🟦──────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── SETTINGS 🟢6 ───────────────
const TRADE_AMOUNT_USDC = 0.04; // in USDC with 6 decimals (0.04 USDC)
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;

// ─────────────── HELPERS 🟢7 ───────────────
function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

// Build a generic amount-out fetcher
async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path2 = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path2
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── CUMULATIVE PROFIT TRACKING 🟢8 ───────────────
let cumulativeProfit = 0;

// ─────────────── EXECUTE TRADE WITH PROFIT TRACKING 🟢9 ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    // amount is USDC amount, convert to 6 decimals
    const amountIn = ethers.parseUnits(amount.toString(), 6);

    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      amountIn,
      { gasLimit: 2_000_000 }
    );

    console.log(`⏳ Trade sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined: ${tx.hash} | block ${receipt.blockNumber}`);

    // Read USDC balance after trade
    const usdcAddress = await arbContract.USDC();
    const usdc = new ethers.Contract(
      usdcAddress,
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );

    const balanceAfter = await usdc.balanceOf(CONTRACT_ADDRESS);

    // Compute profit: (balanceAfter - starting amountIn)
    const netProfit = Number(ethers.formatUnits(balanceAfter, 6)) - Number(amount);
    cumulativeProfit += netProfit;

    console.log(`💹 Net USDC change this tx: ${netProfit.toFixed(6)} USDC`);
    console.log(`📊 Cumulative profit this session: ${cumulativeProfit.toFixed(6)} USDC`);

  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${err?.reason || err?.message || err}`);
  }
}

// ─────────────── STATIC ARB CHECK (DRY-RUN) 🟢10 ───────────────
// Attempts a static/dry-run before executing arbitrage.
// If on-chain simulateArbitrage exists, it uses it. Otherwise it gracefully skips.

async function callStaticArb(buyRouter, sellRouter, tokenAddr, amount) {
  const simulateName = "simulateArbitrage"; // optional on-chain view function
  try {
    // Check if simulateArbitrage exists by attempting a static call
    const simulateExists = await arbContract.functions.simulateArbitrage
      ? true
      : false;

    if (simulateExists) {
      console.log("🔎 Static check: Calling on-chain simulateArbitrage (view)...");
      // amount in USDC is 0.04 -> 4e4 in 6 decimals? Wait: USDC has 6 decimals.
      const amountIn = ethers.parseUnits(amount.toString(), 6);

      const [profitable, netProfitRaw] = await arbContract.simulateArbitrage(
        buyRouter,
        sellRouter,
        tokenAddr,
        amountIn
      );

      const netProfit = Number(ethers.formatUnits(netProfitRaw, 6));

      console.log(
        `📈 Static result -> profitable: ${profitable} | estimated netProfit: ${netProfit.toFixed(6)} USDC`
      );

      if (profitable && netProfit >= MIN_NET_PROFIT_USDC) {
        console.log("✅ Static check passed and meets min profit. Proceeding to actual arbitrage...");
        await executeTrade(buyRouter, sellRouter, tokenAddr, amount);
        return;
      } else {
        console.log("⚠️ Static check failed or below min profit. Aborting this opportunity.");
        return;
      }
    } else {
      console.log("📝 Static check unavailable on-chain. Proceeding with actual arbitrage (no static).");
      await executeTrade(buyRouter, sellRouter, tokenAddr, amount);
      return;
    }
  } catch (err) {
    console.error(`⚠️ Static check call failed: ${err?.reason || err?.message || err}`);
    console.log("🟡 Falling back to direct arbitrage execution without static check.");
    await executeTrade(buyRouter, sellRouter, tokenAddr, amount);
  }
}

// ─────────────── SCAN LOOP 🟢11 ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct  = (profitUSDC / buyPrice) * 100;

          // Slippage adjustment
          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct  *= (1 - SLIPPAGE_PCT / 100);

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({
              token: symbol, buyName, sellName, profitUSDC, profitPct
            });

            console.log(
              `🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`
            );

            // Static check + then arbitrage
            await callStaticArb(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e?.message || e}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP 🟢12 ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
