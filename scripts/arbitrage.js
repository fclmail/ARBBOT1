import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const TRADE_USDC = 0.03;
const MIN_PROFIT = 0.00001;

const SLIPPAGE_BPS = 50;
const INTERVAL = 8000;
const DRY_RUN = false;

/* =====================================================
   TOKENS
===================================================== */

const TOKENS = [
  { symbol:"WBTC", address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals:8 },
  { symbol:"AAVE", address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals:18 },
  { symbol:"CRV",  address:"0x172370d5cd63279efa6d502dab29171933a610af", decimals:18 },
  { symbol:"LINK", address:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals:18 },
  { symbol:"UNI",  address:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals:18 }
];

/* =====================================================
   HELPERS (CRITICAL)
===================================================== */

const from6 = v => ethers.parseUnits(v.toFixed(6), 6);
const to6   = v => Number(ethers.formatUnits(v, 6));

const fromToken = (v,d) => ethers.parseUnits(v.toFixed(d), d);
const toToken   = (v,d) => Number(ethers.formatUnits(v, d));

const applySlippageRaw = (v) =>
  v * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n;

/* =====================================================
   CORE SCAN
===================================================== */

async function scan() {
  for (const token of TOKENS) {
    for (const buy of DEXES) {
      for (const sell of DEXES) {
        if (buy === sell) continue;

        try {
          let bestBuyRaw = 0n;
          let bestBuyNorm = 0;

          // 🔹 BUY SIDE
          for (const p of pathsBuy(token.address)) {
            const out = await buy.router.getAmountsOut(from6(TRADE_USDC), p);
            const raw = out.at(-1);
            const norm = toToken(raw, token.decimals);

            if (norm > bestBuyNorm) {
              bestBuyNorm = norm;
              bestBuyRaw = raw;
            }
          }
          if (!bestBuyRaw) continue;

          // 🔹 SELL SIDE
          let bestSellRaw = 0n;

          for (const p of pathsSell(token.address)) {
            const out = await sell.router.getAmountsOut(bestBuyRaw, p);
            if (out.at(-1) > bestSellRaw) {
              bestSellRaw = out.at(-1);
            }
          }

          const profitRaw = bestSellRaw - from6(TRADE_USDC);

          const profit = to6(profitRaw);
          console.log(
            `[SIM] ${token.symbol} ${buy.name}→${sell.name} profit:${profit.toFixed(6)}`
          );

          if (profitRaw < from6(MIN_PROFIT)) continue;

          console.log(`🟢 EXECUTING ${token.symbol} PROFIT ${profit.toFixed(6)}`);

          if (DRY_RUN) return;

          const minTokenOut = applySlippageRaw(bestBuyRaw);
          const minUSDCOut  = applySlippageRaw(bestSellRaw);

          const tx = await vault.executeArbitrage(
            buy.address,
            sell.address,
            token.address,
            from6(TRADE_USDC),
            minTokenOut,
            minUSDCOut,
            from6(MIN_PROFIT)
          );

          console.log(`📤 TX SENT ${tx.hash}`);
          await tx.wait();
          console.log(`✅ CONFIRMED`);
          return;

        } catch (e) {
          console.error("❌ EXEC FAIL:", e.reason || e.message);
        }
      }
    }
  }
}
