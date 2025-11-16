
Gmail is better on the app
Secure, fast & organized email
Open
cstatic dry 🚀✅ 25 11 16 157am
C
CASHCOIN
to me
12 hours agoDetails
// ─────────────────────────────────────────────
// AAVE FLASH ARB BOT — DRY-RUN with callStatic Debug
// - Simulates executeArbitrage via callStatic (no txs sent)
// - Decodes revert reasons & prints full error object
// - If static succeeds, runs simulated execution and updates cumulativeProfit
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Dry-run toggle: default ON. Set DRY_RUN=false to allow live behavior (but this file is DRY-RUN oriented).
const DRY_RUN = process.env.DRY_RUN ? process.env.DRY_RUN === "true" : true;

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Basic runtime checks
console.log(`\n🚀 Starting arb bot — DRY_RUN=${DRY_RUN}`);
console.log(`🏛 RPC: ${RPC_URL}`);
console.log(`🔗 Contract: ${CONTRACT_ADDRESS}\n`);

// ---------- CONTRACT ABI (minimal) ----------
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

// Contract instance bound to provider (read-only + callStatic)
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// Quick self-check (async IIFE)
(async () => {
  try {
    console.log("✅ Contract address (read):", await arbContract.getAddress());
    console.log("👤 Contract owner (read):", await arbContract.owner());
  } catch (e) {
    console.warn("⚠️ Could not read contract address/owner (node may be rate-limited). Continuing.\n", e.message || e);
  }
})();

// ---------- Routers ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ---------- Tokens ----------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ---------- Settings ----------
const TRADE_AMOUNT_USDC = 0.04;   // base USDC used to probe price
const MIN_PROFIT_PCT = 3;         // only consider opportunities >= this %
const SLIPPAGE_PCT = 0;           // used to reduce profit estimates conservatively

// ---------- Utilities ----------
function fmt(n, dec = 4) { return Number(n).toFixed(dec); }

// getAmountOut: queries a DEX router's getAmountsOut
async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  // get USDC address from arbContract (read-only)
  let usdcAddress;
  try {
    usdcAddress = await arbContract.USDC();
  } catch (e) {
    throw new Error("Failed to read USDC address from contract: " + (e.message || e));
  }

  const pathDirect = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      pathDirect
    );
    // amounts is an array of uints; last index -> token amount
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch (err) {
    // try fallback via WBTC
    const pathFallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      pathFallback
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ---------- Cumulative profit tracking ----------
let cumulativeProfit = 0;

// ---------- simulateArbCall: callStatic wrapper ----------
async function simulateArbCall(buyRouter, sellRouter, tokenAddr, amountIn) {
  // Purpose: run callStatic to simulate the exact executeArbitrage call
  // Returns object: { success: boolean, error: any (if failed) }
  try {
    // callStatic simulates the transaction and will throw if it would revert
    await arbContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountIn.toString(), 6)
    );

    // If callStatic finished without throwing, it suggests the transaction would succeed.
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err };
  }
}

// ---------- decodeStaticCallError: verbose error printing ----------
function decodeStaticCallError(err) {
  console.log("\n────────────────── STATIC CALL DEBUG — START ──────────────────");

  try {
    // Print summary fields commonly present
    console.log("🔸 error.name:", err.name);
    console.log("🔸 error.code:", err.code);
    if (err.reason) console.log("🔸 revert reason:", err.reason);
    if (err.message) console.log("🔸 message:", err.message);

    // Some providers (ethers) put the revert data in err.data or err.error?.data
    const dataCandidates = [
      err.data,
      err.error && err.error.data,
      err.body, // sometimes raw HTTP body
    ];

    const data = dataCandidates.find(d => d);
    if (data) {
      console.log("🔸 raw data (err.data or err.error.data):", data);
      // try to parse common ABI encoded revert reason:
      try {
        // Many revert strings are ABI-encoded as Error(string) -> function selector + encoded string
        // If data is hex and long enough, try to decode the tail as utf8
        const hex = (typeof data === "string") ? data : (data.data ? data.data : null);
        if (hex && hex.startsWith("0x")) {
          // Attempt to decode printable substring(s)
          // Common layout: 0x08c379a0 + offset + length + string bytes
          // We'll try to extract printable characters
          const asUtf8 = ethers.toUtf8String(hex);
          console.log("🔸 toUtf8String(decoded):", asUtf8);
        }
      } catch (subErr) {
        // ignore decode errors
      }
    }

    // Print full object for deep debugging
    console.log("\n🔸 FULL ERROR OBJECT (truncated deep inspect):");
    console.dir(err, { depth: 5, colors: true });

    // Detect panic codes in some providers (e.g., Solidity Panic(uint256))
    if (err.code === "CALL_EXCEPTION") {
      console.log("\n💥 CALL_EXCEPTION: solidity-level revert/panic likely occurred.");
    }

  } catch (outer) {
    console.error("Failed to decode static call error:", outer);
  }

  console.log("────────────────── STATIC CALL DEBUG — END ──────────────────\n");
}

// ---------- executeTradeSimulated: mirrors executeTrade behavior but doesn't send tx ----------
async function executeTradeSimulated(buyRouter, sellRouter, tokenAddr, amount) {
  console.log("🧪 ---------- Simulated Trade Execution ----------");
  console.log("🧪 buyRouter:", buyRouter);
  console.log("🧪 sellRouter:", sellRouter);
  console.log("🧪 token:", tokenAddr);
  console.log("🧪 amount (USDC):", amount);

  // Generate a deterministic-ish simulated profit (for test repeatability you might seed RNG)
  const simulatedNet = Number((Math.random() * 0.03).toFixed(6)); // 0 - 3% random simulated profit
  cumulativeProfit += simulatedNet;

  console.log(`💹 [SIM] Net USDC change (simulated): ${simulatedNet.toFixed(6)} USDC`);
  console.log(`📊 [SIM] Cumulative USDC profit: ${cumulativeProfit.toFixed(6)} USDC`);
  console.log("🧪 ---------------------------------------------\n");
}

// ---------- scan loop ----------
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

          // Protect against zero/invalid quotes
          if (!buyOut || !sellOut) continue;

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct  = (profitUSDC / buyPrice) * 100;

          // Apply slippage margin
          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct   *= (1 - SLIPPAGE_PCT / 100);

          if (profitPct >= MIN_PROFIT_PCT) {
            // Found candidate
            console.log(`🚨 ${symbol} | Buy:${buyName} @ ${fmt(buyPrice)} → Sell:${sellName} @ ${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

            // 1) Run callStatic to simulate executeArbitrage
            try {
              console.log("🧪 Running callStatic simulation of executeArbitrage() ...");
              const simRes = await simulateArbCall(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);

              if (!simRes.success) {
                console.warn("❌ callStatic failed — this trade would revert if sent. Emitting debug info.");
                decodeStaticCallError(simRes.error);
                // push opportunity for record, but do not execute
                opportunities.push({ token: symbol, buyName, sellName, profitUSDC, profitPct, simulated: false, staticError: simRes.error });
              } else {
                console.log("✅ callStatic simulation passed — (dry-run) we will NOT send a tx, running simulated executor instead.");
                // in dry-run mode we simulate the profit capture and update cumulativeProfit
                await executeTradeSimulated(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);

                opportunities.push({ token: symbol, buyName, sellName, profitUSDC, profitPct, simulated: true });
              }
            } catch (simExc) {
              console.error("⚠️ Unexpected error while running callStatic simulation:", simExc);
              decodeStaticCallError(simExc);
              opportunities.push({ token: symbol, buyName, sellName, profitUSDC, profitPct, simulated: false, staticError: simExc });
            }
          }

        } catch (innerErr) {
          console.warn(`⚠️ Error scanning pair ${symbol} ${buyName}->${sellName}:`, innerErr.message || innerErr);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities (simulated/live).`);
  return opportunities;
}

// ---------- main loop ----------
async function main() {
  console.log("🚀 Bot started (DRY RUN with callStatic). Press Ctrl+C to stop.\n");
  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error("Fatal scan error:", e);
    }
    // Sleep 5s between scans
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
