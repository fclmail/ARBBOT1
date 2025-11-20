// scripts/arbitrage.js
/**
 * Option B - Aggressive arbitrage bot
 * - Scan math and execution math use price-spread model:
 *     rawProfit = (sellPrice - buyPrice) * tokenAmount
 * - Execution still uses callStatic to avoid reverted txs.
 * - All vault safety checks present (vault-before/after net check).
 *
 * Requires:
 *   - PRIVATE_KEY env var (owner of the vault contract to execute)
 *   - (optional) RPC_URL env var
 *   - (optional) DRY_RUN=true to simulate
 *
 * Ethers v6 style
 */
import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ------------------ CONFIG ------------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in env");

const DRY_RUN = process.env.DRY_RUN === "true";

const VAULT_CONTRACT_ADDRESS = ethers.getAddress("0x19B64f74553eE0ee26BA01BF34321735E4701C43");
const USDC_ADDRESS = ethers.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174"); // polygon USDC (checksummed)

// DEX routers (checksummed)
const ROUTERS = {
  QuickSwap: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
  SushiSwap: ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
  ApeSwap:   ethers.getAddress("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607")
};

// Chainlink MATIC/USD aggregator (Polygon)
const CHAINLINK_MATIC_USD = ethers.getAddress("0xAB594600376Ec9fD91F8e885dADF0CE036862dE0");

// Safety tuning
const TRADE_AMOUNT_USDC = 10;        // default probe amount (USDC)
const TRADE_AMOUNTS_TO_PROBE = [0.001, 0.01, 10, 1000, 100000, 1000000]; // optional; not used automatically
const MIN_NET_PROFIT_USDC = 0.001;   // requested minimum net profit
const SLIPPAGE_PCT = 0.2;            // conservative slippage factor applied to spread
const MIN_PROFIT_PCT = 0.5;          // percent threshold (informational)
const MAX_PRICE_DELTA = 0.10;        // 10% price dev allowed between reserves
const MIN_PROFIT_GAS_MULTIPLIER = 1.5; // rawProfit must exceed estGas * multiplier
const COOLDOWN_MS_AFTER_REVERT = 20000;
const SCAN_INTERVAL_MS = 30000;      // continuous scan every 30s
const CSV_PREFIX = "arbitrage_log_";

// ------------------ ABIs ------------------
const ARB_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function owner() view returns (address)",
  "function USDC() view returns (address)"
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"
];

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"
];

// ------------------ SETUP ------------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ARB_ABI, wallet);
const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
const chainlink = new ethers.Contract(CHAINLINK_MATIC_USD, CHAINLINK_ABI, provider);

// CSV logging
let csvRows = [];
function pushCsv(obj) {
  csvRows.push([
    obj.ts || new Date().toISOString(),
    obj.token || "",
    obj.buyDex || "",
    obj.sellDex || "",
    obj.amountUSDC ?? "",
    obj.rawProfitUSDC ?? "",
    obj.netProfitUSDC ?? "",
    obj.txHash || ""
  ].join(","));
}
function saveCsv() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyDex","SellDex","AmountUSDC","RawProfitUSDC","NetProfitUSDC","txHash"].join(",");
  const out = [header, ...csvRows].join("\n");
  const fname = `${CSV_PREFIX}${Date.now()}.csv`;
  fs.writeFileSync(fname, out);
  console.log(`💾 Saved CSV: ${fname}`);
  csvRows = [];
}

// ------------------ HELPERS ------------------
function fmt(n, d=6) { return Number(n).toFixed(d); }
async function getTokenDecimals(tokenAddr) {
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const d = await c.decimals();
    return Number(d);
  } catch (e) {
    return 18;
  }
}
async function getVaultBalanceUSDC() {
  try {
    const raw = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
    return Number(ethers.formatUnits(raw, 6));
  } catch (e) {
    console.warn("WARN vault read failed:", e.message || e);
    return null;
  }
}
async function getMaticUsd() {
  try {
    const r = await chainlink.latestRoundData();
    return Number(r[1]) / 1e8;
  } catch (e) {
    console.warn("WARN: Chainlink failed, fallback 0.5");
    return 0.5;
  }
}
async function gasToUSD(gasBN, gasPriceBN) {
  try {
    const maticUsd = await getMaticUsd();
    const native = Number(ethers.formatUnits(gasBN * gasPriceBN, 18));
    return native * maticUsd;
  } catch (e) {
    return Number(ethers.formatUnits(gasBN * gasPriceBN, 18)) * 0.5;
  }
}
async function routerGetAmountsOut(routerAddr, amountBN, path) {
  const r = new ethers.Contract(routerAddr, ROUTER_ABI, provider);
  return await r.getAmountsOut(amountBN, path);
}
function priceDeltaAllowed(p1, p2) {
  if (p1 <= 0 || p2 <= 0) return false;
  const delta = Math.abs(p1 - p2) / ((p1 + p2) / 2);
  return delta <= MAX_PRICE_DELTA;
}

// ------------------ CORE: price-spread based rawProfit (used in both scan & execution) ------------------
/**
 * Compute spread-based metrics given:
 *  - buyRouter: router address to buy token with USDC for amountInUSDC
 *  - sellRouter: router address to sell tokens back to USDC
 *  - token: token address
 *  - amountInUSDC: numeric (USDC)
 *
 * Returns:
 *  { buyPrice, sellPrice, buyTokens, rawProfitUSDC, profitPct, buyTokensBN, amountInBN }
 */
async function computeSpreadMetrics(buyRouter, sellRouter, token, amountInUSDC) {
  // amountIn as BigInt using USDC decimals (6)
  const amountInBN = ethers.parseUnits(amountInUSDC.toString(), 6);

  // 1) get buyAmounts: USDC -> token
  const buyAmounts = await routerGetAmountsOut(buyRouter, amountInBN, [USDC_ADDRESS, token]);
  const buyTokensBN = buyAmounts[1];

  // 2) compute sellAmounts if needed to compute sellPrice using token amount
  const sellAmounts = await routerGetAmountsOut(sellRouter, buyTokensBN, [token, USDC_ADDRESS]);
  const sellUSDCBN = sellAmounts[1];

  // decimals
  const tokenDecimals = await getTokenDecimals(token);

  const buyTokens = Number(ethers.formatUnits(buyTokensBN, tokenDecimals));         // token quantity received
  const usdcIn = Number(ethers.formatUnits(amountInBN, 6));                        // USDC input numeric
  const usdcOut = Number(ethers.formatUnits(sellUSDCBN, 6));                       // USDC if selling the bought tokens

  // implied per-token prices
  const buyPrice = usdcIn / (buyTokens || 1e-18);   // USDC per token at buy DEX
  const sellPrice = usdcOut / (buyTokens || 1e-18);// USDC per token at sell DEX

  // rawProfit (spread-based) = (sellPrice - buyPrice) * tokenAmount
  let rawProfitUSDC = (sellPrice - buyPrice) * buyTokens;

  // apply conservative slippage reduction
  rawProfitUSDC *= (1 - SLIPPAGE_PCT / 100);

  const profitPct = (rawProfitUSDC / (buyPrice * buyTokens || 1e-18)) * 100;

  return {
    buyPrice,
    sellPrice,
    buyTokens,
    rawProfitUSDC,
    profitPct,
    buyTokensBN,
    amountInBN,
    usdcOut, // informational
    usdcIn
  };
}

// ------------------ SCAN & EXECUTION (Option B: same math used for both) ------------------
async function tryScanAndExecute() {
  console.log("🔍 Scanning for arbitrage opportunities (price-spread math enabled everywhere)...");

  // tokens to scan
  const tokens = {
    AAVE: ethers.getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"),
    CRV:  ethers.getAddress("0x172370d5cd63279efa6d502dab29171933a610af"),
    LINK: ethers.getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"),
    WBTC: ethers.getAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6")
  };

  const routerEntries = Object.entries(ROUTERS);
  const opportunities = [];

  for (const [symbol, tokenAddr] of Object.entries(tokens)) {
    for (let i = 0; i < routerEntries.length; i++) {
      for (let j = 0; j < routerEntries.length; j++) {
        if (i === j) continue;
        const [buyName, buyRouter] = routerEntries[i];
        const [sellName, sellRouter] = routerEntries[j];

        try {
          // compute spread metrics using price-based math
          const metrics = await computeSpreadMetrics(buyRouter, sellRouter, tokenAddr, TRADE_AMOUNT_USDC);

          // log
          console.log(`${symbol} | ${buyName} $${fmt(metrics.buyPrice)} → ${sellName} $${fmt(metrics.sellPrice)} | Estimated Profit: ${fmt(metrics.rawProfitUSDC)} USDC (${fmt(metrics.profitPct,2)}%)`);

          // basic negative/zero check
          if (!isFinite(metrics.rawProfitUSDC) || metrics.rawProfitUSDC <= 0) {
            // skip
            continue;
          }

          // greater than minimal thresholds?
          if (metrics.rawProfitUSDC < MIN_NET_PROFIT_USDC || metrics.profitPct < MIN_PROFIT_PCT) {
            console.log(`❌ Rejected — below minimum thresholds (raw ${fmt(metrics.rawProfitUSDC)} / pct ${fmt(metrics.profitPct,2)}%)`);
            continue;
          }

          // price deviation guard (stale reserves / false arbitrage)
          if (!priceDeltaAllowed(metrics.buyPrice, metrics.sellPrice)) {
            console.log(`⚠ Price deviation = ${Math.abs(metrics.buyPrice - metrics.sellPrice) / ((metrics.buyPrice + metrics.sellPrice)/2) * 100:.2f}% (>${MAX_PRICE_DELTA*100}%) — Rejected`);
            continue;
          }

          // callStatic to ensure the on-chain mechanism will not revert (saves gas)
          console.log("⏳ Running callStatic simulation...");
          try {
            await vaultContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, metrics.amountInBN);
          } catch (callErr) {
            console.log("❌ callStatic failed — blocking trade (no gas spent):", callErr.reason || callErr.message || callErr.toString());
            // cooldown optionally
            continue;
          }

          // gas estimate
          const gasEstimate = await vaultContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, metrics.amountInBN).catch(() => null);
          if (!gasEstimate) {
            console.log("❌ estimateGas failed — blocking trade");
            continue;
          }
          const feeData = await provider.getFeeData();
          const gasPriceBN = feeData.gasPrice ?? ethers.parseUnits("100", "gwei");
          const estGasUSD = await gasToUSD(gasEstimate, gasPriceBN);
          console.log(`⛽ Estimated gas cost ≈ ${fmt(estGasUSD)} USDC (converted via Chainlink MATIC/USD)`);

          if (metrics.rawProfitUSDC < estGasUSD * MIN_PROFIT_GAS_MULTIPLIER) {
            console.log("❌ Rejected — rawProfit < estGas * multiplier (conservative)");
            continue;
          }

          // PASS checks — either DRY_RUN or execute
          console.log("☑ Candidate PASSING checks (will execute unless DRY_RUN).");

          if (DRY_RUN) {
            console.log("ℹ DRY_RUN mode: not sending tx. Candidate recorded.");
            opportunities.push({ symbol, buyName, sellName, rawProfit: metrics.rawProfitUSDC });
            continue;
          }

          // Vault BEFORE reading
          const vaultBefore = await getVaultBalanceUSDC();
          console.log(`🏦 Vault Before: ${vaultBefore !== null ? fmt(vaultBefore) + " USDC" : "unknown"}`);

          // Execute on-chain
          console.log("💸 Sending executeArbitrage tx ...");
          const txResp = await vaultContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, metrics.amountInBN, { gasLimit: gasEstimate.mul(120).div(100) }).catch(e => { throw e; });
          if (!txResp || !txResp.hash) throw new Error("txResponse missing hash");
          console.log("🔗 txHash:", txResp.hash);
          const txRcpt = await txResp.wait();

          if (!txRcpt || txRcpt.status !== 1) {
            console.log("❌ On-chain tx failed or reverted — cooling down");
            await new Promise(r => setTimeout(r, COOLDOWN_MS_AFTER_REVERT));
            continue;
          }

          // Vault AFTER
          const vaultAfter = await getVaultBalanceUSDC();
          const net = (vaultAfter !== null && vaultBefore !== null) ? vaultAfter - vaultBefore : null;

          console.log(`⛽ Gas Used: ${txRcpt.gasUsed ? txRcpt.gasUsed.toString() : "unknown"}`);
          console.log(`🏦 Vault After: ${vaultAfter !== null ? fmt(vaultAfter) + " USDC" : "unknown"}`);

          if (net === null) {
            console.log("WARN: could not compute net profit (vault read failed). Logging candidate.");
            pushCsv({ ts: new Date().toISOString(), token: symbol, buyDex: buyName, sellDex: sellName, amountUSDC: TRADE_AMOUNT_USDC, rawProfitUSDC: fmt(metrics.rawProfitUSDC), netProfitUSDC: "", txHash: txResp.hash });
            saveCsv();
            continue;
          }

          if (net <= 0) {
            // EMERGENCY guard: vault decreased — stop bot and alert
            pushCsv({ ts: new Date().toISOString(), token: symbol, buyDex: buyName, sellDex: sellName, amountUSDC: TRADE_AMOUNT_USDC, rawProfitUSDC: fmt(metrics.rawProfitUSDC), netProfitUSDC: fmt(net), txHash: txResp.hash });
            saveCsv();
            throw new Error(`EMERGENCY: Vault did not increase after trade. before=${vaultBefore} after=${vaultAfter}`);
          }

          console.log(`✅ Trade successful: Real Net +${fmt(net)} USDC`);
          pushCsv({ ts: new Date().toISOString(), token: symbol, buyDex: buyName, sellDex: sellName, amountUSDC: TRADE_AMOUNT_USDC, rawProfitUSDC: fmt(metrics.rawProfitUSDC), netProfitUSDC: fmt(net), txHash: txResp.hash });
          saveCsv();

          opportunities.push({ symbol, buyName, sellName, rawProfit: metrics.rawProfitUSDC, net });
          // small delay to avoid mempool spam
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.warn(`⚠ Error handling ${symbol} ${buyName}->${sellName}:`, err.reason || err.message || err);
          // continue scanning
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} executed/queued opportunities.\n`);
  return opportunities;
}

// ------------------ MAIN LOOP ------------------
async function main() {
  console.log("🚀 LIVE MODE ENABLED — AGGRESSIVE PRICE-SPREAD EXECUTION (Option B)");
  console.log("🏛 Vault Contract:", VAULT_CONTRACT_ADDRESS);
  try {
    const owner = await vaultContract.owner();
    console.log("👤 Vault Owner:", owner);
    const myAddr = await wallet.getAddress();
    if (owner.toLowerCase() !== myAddr.toLowerCase()) {
      console.warn("⚠ Wallet is not vault owner. callStatic/execute may revert. Use a key that is the owner to run live.");
    }
  } catch (e) {
    console.warn("WARN: could not read owner:", e.message || e);
  }

  while (true) {
    try {
      await tryScanAndExecute();
    } catch (e) {
      console.error("UNCAUGHT ERROR in main loop:", e.stack || e.message || e);
      // save CSV on serious errors
      try { saveCsv(); } catch {}
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error("Fatal:", err.stack || err.message || err);
  try { saveCsv(); } catch {}
  process.exit(1);
});
