import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

//───────────────────────────────────────
// CONFIG
//───────────────────────────────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const DRY_RUN = true;                // 🔥 TRUE = no real tx, only simulated
const BASE_TRADE_USDC = 1;           // always 1 USDC normalized
const PROFIT_THRESHOLD_USDC = 0.01;  // min profitable trade

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

// Provider + Wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

//───────────────────────────────────────
// CONTRACT ABI
//───────────────────────────────────────
const arbAbi = [
  {
    "inputs": [
      {"internalType": "address", "name": "buyRouter", "type": "address"},
      {"internalType": "address", "name": "sellRouter", "type": "address"},
      {"internalType": "address", "name": "token", "type": "address"},
      {"internalType": "uint256", "name": "amountIn", "type": "uint256"}
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {"inputs": [], "name": "USDC", "outputs": [{"type": "address"}], "stateMutability": "view"},
  {"inputs": [], "name": "owner", "outputs": [{"type": "address"}], "stateMutability": "view"}
];

const arb = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

//───────────────────────────────────────
// ROUTERS (checksum-fixed)
//───────────────────────────────────────
const routers = {
  quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  dfyn:      "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73".toLowerCase(),
  apeswap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Fix checksum automatically:
Object.keys(routers).forEach(k => {
  try { routers[k] = ethers.getAddress(routers[k]); }
  catch { console.log(`⚠️ Router checksum invalid, skipping: ${routers[k]}`); delete routers[k]; }
});

//───────────────────────────────────────
// TOKENS (Full Decimals)
//───────────────────────────────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

//───────────────────────────────────────
// HELPERS
//───────────────────────────────────────
function fmt(n, d=6) { return Number(n).toFixed(d); }

async function safeGetAmountsOut(routerAddr, token, amountUsdc) {
  const router = new ethers.Contract(
    routerAddr,
    [
      "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[])"
    ],
    provider
  );

  const usdc = await arb.USDC();
  const amountIn = ethers.parseUnits(amountUsdc.toString(), 6);
  const direct = [usdc, token.address];

  try {
    const out = await router.getAmountsOut(amountIn, direct);
    return Number(ethers.formatUnits(out[1], token.decimals));
  } catch(e1) {
    // fallback path USDC→WBTC→token
    try {
      const path2 = [usdc, tokens.WBTC.address, token.address];
      const out = await router.getAmountsOut(amountIn, path2);
      return Number(ethers.formatUnits(out[out.length-1], token.decimals));
    } catch(e2) {
      return null;
    }
  }
}

//───────────────────────────────────────
// SAFE SWAP (NO CALL STATIC)
//───────────────────────────────────────
async function safeSwap(buyRouter, sellRouter, token, amountUsdc) {
  if (DRY_RUN) return { ok: true, tx: "dry_run" };

  try {
    const tx = await arb.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amountUsdc.toString(), 6),
      { gasLimit: 2_000_000 }
    );
    const receipt = await tx.wait();
    return { ok: true, tx: receipt.transactionHash };
  } catch (err) {
    return {
      ok: false,
      reason: err.reason,
      msg: err.message
    };
  }
}

//───────────────────────────────────────
// PROFIT ENGINE
//───────────────────────────────────────
let accumulatedProfit = 0;

//───────────────────────────────────────
// SCANNER
//───────────────────────────────────────
async function scan() {
  console.log("\n🔎 SCANNING...\n");

  for (const [sym, token] of Object.entries(tokens)) {
    for (const [buyName, buyAddr] of Object.entries(routers)) {
      for (const [sellName, sellAddr] of Object.entries(routers)) {

        if (buyName === sellName) continue;

        try {
          const outBuy  = await safeGetAmountsOut(buyAddr, token, BASE_TRADE_USDC);
          const outSell = await safeGetAmountsOut(sellAddr, token, BASE_TRADE_USDC);

          if (!outBuy || !outSell) {
            console.log(`⏭️ ${sym} | Missing liquidity | ${buyName} → ${sellName}`);
            continue;
          }

          // normalize to USDC value of tokens
          const buyPrice  = BASE_TRADE_USDC / outBuy;
          const sellPrice = BASE_TRADE_USDC / outSell;

          const profit = sellPrice - buyPrice;

          if (profit < PROFIT_THRESHOLD_USDC) continue;

          console.log(
            `🚨 ${sym} | Buy:${buyName} @ ${fmt(buyPrice)} → Sell:${sellName} @ ${fmt(sellPrice)} | Profit: ${fmt(profit)}`
          );

          // EXECUTE
          const tx = await safeSwap(buyAddr, sellAddr, token, BASE_TRADE_USDC);

          if (!tx.ok) {
            console.log(`❌ Swap failed: ${tx.msg || tx.reason}`);
            continue;
          }

          if (DRY_RUN) {
            accumulatedProfit += profit;
            console.log(`💰 DRY RUN PROFIT +${fmt(profit)} | Total: ${fmt(accumulatedProfit)}`);
          } else {
            console.log(`✅ LIVE TX: ${tx.tx}`);
          }

        } catch (err) {
          console.log(`⚠️ Error scanning ${sym}: ${err.message}`);
        }
      }
    }
  }
}

//───────────────────────────────────────
// MAIN LOOP
//───────────────────────────────────────
async function main() {
  console.log("🚀 Arbitrage bot running");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main();
