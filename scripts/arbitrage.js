// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Cumulative Profit Tracking)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();


// ─────────────── CONFIG 🟢1 ───────────────
// This section loads environment variables, defines essential parameters,
// sets provider & wallet, and ensures required data is present.
//
// • RPC_URL → Polygon endpoint  
// • PRIVATE_KEY → wallet that deployed the contract  
// • CONTRACT_ADDRESS → on-chain arbitrage contract  
// • MIN_NET_PROFIT_USDC → minimum profit required after gas costs  
//-------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // deployed contract
const MIN_NET_PROFIT_USDC = 1; // minimum profit after gas

// Safety check: prevents accidental execution with missing credentials
if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

// Initialize blockchain provider
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Load wallet instance (signer)
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);



// ─────────────── FULL CONTRACT ABI 🟢2 ───────────────
// ABI describes the functions inside your deployed arbitrage contract.
// This enables JS → Smart Contract interaction.
//
// executeArbitrage()  → performs the flash swap + trades  
// USDC()              → returns the USDC token address  
// owner()             → contract owner verification  
// ---------------------------------------------------------------------

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
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];



// ─────────────── CONTRACT CONNECTION 🟢3 ───────────────
// Creates JS contract instance bound to your wallet.
// Allows calling executeArbitrage() with authorized signer.
// ---------------------------------------------------------------------

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

(async () => {
  console.log("✅ Connected to contract:", await arbContract.getAddress());
  console.log("👤 Contract owner:", await arbContract.owner());
})();



// ─────────────── ROUTERS 🟢4 ───────────────
// These are swap router addresses used by the arbitrage bot.
// Each router corresponds to a DEX where prices may differ.
//
// Bot compares price differences between these DEXs:
// • QuickSwap  
// • SushiSwap  
// • Dfyn  
// • ApeSwap  
// ---------------------------------------------------------------------

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};



// ─────────────── TOKENS 🟢5 ───────────────
// Tokens selected for arbitrage opportunities.
// Each token contains:
// • address on Polygon  
// • decimals used for formatting  
//
// Trading pairs: USDC → Token → USDC
// ---------------------------------------------------------------------

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};



// ─────────────── SETTINGS 🟢6 ───────────────
// Trade configuration:
//
// TRADE_AMOUNT_USDC → input amount per arbitrage test  
// MIN_PROFIT_PCT    → minimum percent difference needed  
// SLIPPAGE_PCT      → optional safety reduction for real execution  
// ---------------------------------------------------------------------

const TRADE_AMOUNT_USDC = 0.04;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;



// ─────────────── HELPERS 🟢7 ───────────────
// Helper utilities:
//
// fmt()           → format number for console  
// getAmountOut()  → fetch expected token output from router
//
// If direct USDC → token fails, fallback USDC→WBTC→token is used.
// ---------------------------------------------------------------------

function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

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
    // fallback routing path on routers that don't support direct pair
    const path2 = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path2
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}



// ─────────────── CUMULATIVE PROFIT TRACKING 🟢8 ───────────────
// cumulativeProfit stores profit across entire bot runtime.
// Resets each time script is restarted.
// ---------------------------------------------------------------------

let cumulativeProfit = 0;



// ─────────────── EXECUTE TRADE WITH PROFIT TRACKING 🟢9 ───────────────
// Executes the arbitrage contract and logs:
// • transaction hash  
• mined block number  
• net USDC profit for this trade  
• cumulative total profit  
//
// Steps:
// 1. Call executeArbitrage()
// 2. Wait for transaction confirmation
// 3. Fetch contract USDC balance
// 4. Compute net change since starting amount
// ---------------------------------------------------------------------

async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), 6),
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

    // Compute profit: (balanceAfter - amountIn)
    const netProfit = ethers.formatUnits(balanceAfter, 6) - amount;
    cumulativeProfit += netProfit;

    console.log(`💹 Net USDC change this tx: ${netProfit.toFixed(6)} USDC`);
    console.log(`📊 Cumulative profit this session: ${cumulativeProfit.toFixed(6)} USDC`);

  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${err.reason || err.message}`);
  }
}



// ─────────────── SCAN LOOP 🟢10 ───────────────
// This function loops through:
// • Every token  
• Every buy router  
• Every sell router  
//
// For each pair it:
// 1. Fetches buy price and sell price  
2. Calculates % difference  
3. Logs profitable trades  
4. Executes arbitrage if profit ≥ MIN_PROFIT_PCT  
//
// opportunities[] stores only trades that exceeded profitability threshold.
// ---------------------------------------------------------------------

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

          // Adjust for slippage
          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct  *= (1 - SLIPPAGE_PCT / 100);

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({
              token: symbol, buyName, sellName, profitUSDC, profitPct
            });

            console.log(
              `🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`
            );

            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}



// ─────────────── MAIN LOOP 🟢11 ───────────────
// Main execution loop:
// • Runs forever  
• Calls scan() every 5 seconds  
// ---------------------------------------------------------------------

async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
