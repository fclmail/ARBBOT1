// scripts/arbitrage.js
// Option A: scan-style price math in scanner; execution & failsafes unchanged
import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in env");

const DRY_RUN = process.env.DRY_RUN === "true" ? true : false;

const CONTRACT_ADDRESS = ethers.getAddress("0x19B64f74553eE0ee26BA01BF34321735E4701C43"); // vault contract
const USDC_ADDRESS      = ethers.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174"); // Polygon USDC

// DEX routers (checksummed)
const ROUTERS = {
  QuickSwap: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
  SushiSwap: ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
  ApeSwap:   ethers.getAddress("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607")
};

// Chainlink MATIC/USD (Polygon)
const CHAINLINK_MATIC_USD = ethers.getAddress("0xAB594600376Ec9fD91F8e885dADF0CE036862dE0");

// Safety params
const MIN_NET_PROFIT_USDC = 0.001; // requested
const SLIPPAGE_PCT = 0.2; // used for conservative profit estimate in scanner
const MIN_PROFIT_PCT = 0.5; // percent (used previously, still kept)
const COOLDOWN_MS_AFTER_REVERT = 20000;
const SCAN_INTERVAL_MS = 30000; // continuous scan every 30s
const CSV_FILENAME_PREFIX = "arbitrage_log_";

// trade probe amount (USDC) — this is the USDC used to estimate a trade
const TRADE_AMOUNT_USDC = 10; // you can change or test multiple amounts

// ===== ABIs =====
const ARB_ABI = [
  // executeArbitrage as per your contract
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  "function owner() view returns (address)",
  "function USDC() view returns (address)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"
];

const CHAINLINK_AGG = [
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"
];

// ===== PROVIDER / WALLET / CONTRACTS =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);
const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
const chainlink = new ethers.Contract(CHAINLINK_MATIC_USD, CHAINLINK_AGG, provider);

// CSV logging
let csvRows = [];
function logCSV(rowObj) {
  const row = [
    rowObj.timestamp,
    rowObj.token,
    rowObj.buyRouter,
    rowObj.sellRouter,
    rowObj.amountUSDC,
    rowObj.rawProfitUSDC,
    rowObj.netProfitUSDC,
    rowObj.txHash || ""
  ].join(",");
  csvRows.push(row);
}
function saveCsvFile() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","RawProfitUSDC","NetProfitUSDC","txHash"].join(",");
  const payload = [header, ...csvRows].join("\n");
  const fileName = `${CSV_FILENAME_PREFIX}${Date.now()}.csv`;
  fs.writeFileSync(fileName, payload);
  console.log(`💾 Saved CSV: ${fileName}`);
  csvRows = [];
}

// ===== HELPERS =====
function fmt(n, dec=6) { return Number(n).toFixed(dec); }

async function getTokenDecimals(tokenAddr) {
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const d = await c.decimals();
    return Number(d);
  } catch (e) {
    // default 18
    return 18;
  }
}

async function getVaultBalanceUSDC() {
  try {
    const raw = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    return Number(ethers.formatUnits(raw, 6));
  } catch (e) {
    console.warn("WARN: could not read vault USDC balance:", e.message || e);
    return null;
  }
}

async function getMaticUsd() {
  try {
    const res = await chainlink.latestRoundData();
    const answer = Number(res[1]); // usually 8 decimals
    return answer / 1e8;
  } catch (e) {
    console.warn("WARN: Chainlink read failed, fallback to 0.5 USD/MATIC");
    return 0.5;
  }
}

// Convert gas estimate (BigInt) * gasPrice (BigInt) -> USD using Chainlink MATIC/USD
async function gasEstimateToUSDC(gasEstimateBN, gasPriceBN) {
  try {
    const maticUsd = await getMaticUsd();
    const nativeCost = Number(ethers.formatUnits(gasEstimateBN * gasPriceBN, 18)); // ETH/MATIC value
    return nativeCost * maticUsd;
  } catch (e) {
    console.warn("WARN: gas->USD conversion failed:", e.message || e);
    return Number(ethers.formatUnits(gasEstimateBN * gasPriceBN, 18)) * 0.5;
  }
}

// Get amountsOut (returns BigNumber[] or throws)
async function routerGetAmountsOut(routerAddr, amountInBN, path) {
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);
  return await router.getAmountsOut(amountInBN, path);
}

// ===== SCAN (Option A: price-based scan math) =====
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...\n");

  const tokens = {
    AAVE: { address: ethers.getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"), decimals: 18 },
    CRV:  { address: ethers.getAddress("0x172370d5cd63279efa6d502dab29171933a610af"), decimals: 18 },
    LINK: { address: ethers.getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"), decimals: 18 },
    WBTC: { address: ethers.getAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"), decimals: 8 }
  };

  const routers = ROUTERS;
  const opportunities = [];

  // amountInBN in USDC decimals
  const amountInBN = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          // 1) buyAmounts: how many tokens you receive buying `amountInUSDC`
          const buyAmounts = await routerGetAmountsOut(buyRouter, amountInBN, [USDC_ADDRESS, token.address]);
          // buyAmounts[1] is token (raw units)
          const buyTokensBN = buyAmounts[1];

          // 2) sellAmounts: how many USDC you get if you sell the tokens you just bought
          const sellAmounts = await routerGetAmountsOut(sellRouter, buyTokensBN, [token.address, USDC_ADDRESS]);
          const sellUSDCBN = sellAmounts[1];

          // numeric conversions
          const tokenDecimals = token.decimals ?? await getTokenDecimals(token.address);
          const buyTokens = Number(ethers.formatUnits(buyTokensBN, tokenDecimals)); // tokens
          const usdcIn = Number(ethers.formatUnits(amountInBN, 6)); // USDC in
          const usdcOut = Number(ethers.formatUnits(sellUSDCBN, 6)); // USDC out if selling that token

          // Price-per-token (USDC per token) on each DEX (implied)
          const buyPrice  = usdcIn / buyTokens;    // USDC per token on buy DEX
          const sellPrice = usdcOut / buyTokens;   // USDC per token on sell DEX

          // Spread-based profit (USDC)
          let rawProfitUSDC = (sellPrice - buyPrice) * buyTokens;

          // apply conservative slippage reduction
          rawProfitUSDC *= (1 - SLIPPAGE_PCT / 100);

          // percentage for logging
          const profitPct = (rawProfitUSDC / (buyPrice * buyTokens)) * 100;

          console.log(`${symbol} | ${buyName} $${fmt(buyPrice,6)} → ${sellName} $${fmt(sellPrice,6)} | Estimated Profit: ${fmt(rawProfitUSDC,6)} USDC (${fmt(profitPct,2)}%)`);

          // Quick sanity checks
          if (!isFinite(rawProfitUSDC) || rawProfitUSDC <= 0) {
            // not profitable by spread
            continue;
          }

          // Check minimum profit and percent threshold
          if (rawProfitUSDC < MIN_NET_PROFIT_USDC || profitPct < MIN_PROFIT_PCT) {
            console.log(`❌ Rejected — below minimum thresholds (raw ${fmt(rawProfitUSDC,6)} / pct ${fmt(profitPct,2)}%)`);
            continue;
          }

          // Candidate found — now perform full callStatic pre-check (prevents revert & wasted gas)
          console.log("⏳ Running callStatic simulation to verify transaction will succeed...");
          try {
            // simulate call as signer (owner must match wallet)
            await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, token.address, amountInBN);
          } catch (simErr) {
            console.log("❌ callStatic failed — blocking trade (no gas spent):", simErr.reason || simErr.message || simErr.toString());
            continue;
          }

          // estimate gas and cost
          const gasEstimate = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, token.address, amountInBN).catch(e => null);
          if (!gasEstimate) {
            console.log("❌ estimateGas failed — blocking trade");
            continue;
          }
          const feeData = await provider.getFeeData();
          const gasPriceBN = feeData.gasPrice ?? ethers.parseUnits("100", "gwei");
          const estGasCostUSDC = await gasEstimateToUSDC(gasEstimate, gasPriceBN);

          console.log(`⛽ Estimated Gas Cost ≈ ${fmt(estGasCostUSDC,6)} USDC`);

          // ensure profit exceeds gas * multiplier
          if (rawProfitUSDC < estGasCostUSDC * 1.5) {
            console.log("❌ Rejected — rawProfit < gas * multiplier (conservative)");
            continue;
          }

          // PASS: execute trade (unless DRY_RUN)
          console.log("☑ Safe (meets minimum net profit rule and gas check).");

          if (DRY_RUN) {
            console.log("ℹ DRY_RUN enabled — not executing on-chain. Would execute now.");
            opportunities.push({ symbol, buyName, sellName, rawProfitUSDC });
            continue;
          }

          // Read vault before
          const vaultBefore = await getVaultBalanceUSDC();
          console.log(`🏦 Vault Before: ${fmt(vaultBefore,6)} USDC`);

          console.log("💸 EXECUTING REAL TRADE...");
          const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, token.address, amountInBN, { gasLimit: gasEstimate.mul(120).div(100) });
          if (!tx || !tx.hash) {
            console.log("❌ txResponse missing hash — aborting");
            continue;
          }
          console.log("🔗 txHash:", tx.hash);
          const rcpt = await tx.wait();

          if (!rcpt || rcpt.status !== 1) {
            console.log("❌ on-chain tx failed or reverted — cooldown triggered");
            await new Promise(r => setTimeout(r, COOLDOWN_MS_AFTER_REVERT));
            continue;
          }

          // verify vault after
          const vaultAfter = await getVaultBalanceUSDC();
          const net = (vaultAfter !== null && vaultBefore !== null) ? vaultAfter - vaultBefore : null;

          console.log(`⛽ Gas Used: ${rcpt.gasUsed ? rcpt.gasUsed.toString() : "unknown"}`);
          console.log(`🏦 Vault After: ${vaultAfter !== null ? fmt(vaultAfter,6) + " USDC" : "unknown"}`);

          if (net === null) {
            console.log("WARN: couldn't compute net profit (vault read failed)");
            // still log candidate
            logCSV({
              timestamp: new Date().toISOString(),
              token: symbol,
              buyRouter: buyName,
              sellRouter: sellName,
              amountUSDC: TRADE_AMOUNT_USDC,
              rawProfitUSDC: fmt(rawProfitUSDC,6),
              netProfitUSDC: "",
              txHash: tx.hash
            });
          } else if (net <= 0) {
            console.log("❌ Vault decreased or no profit — EMERGENCY: stopping further execution");
            // log and abort
            logCSV({
              timestamp: new Date().toISOString(),
              token: symbol,
              buyRouter: buyName,
              sellRouter: sellName,
              amountUSDC: TRADE_AMOUNT_USDC,
              rawProfitUSDC: fmt(rawProfitUSDC,6),
              netProfitUSDC: fmt(net,6),
              txHash: tx.hash
            });
            saveCsvFile();
            throw new Error(`Vault decreased after trade (before=${vaultBefore}, after=${vaultAfter}) — aborting`);
          } else {
            console.log(`✅ Trade Confirmed — Net Profit: +${fmt(net,6)} USDC`);
            // log
            logCSV({
              timestamp: new Date().toISOString(),
              token: symbol,
              buyRouter: buyName,
              sellRouter: sellName,
              amountUSDC: TRADE_AMOUNT_USDC,
              rawProfitUSDC: fmt(rawProfitUSDC,6),
              netProfitUSDC: fmt(net,6),
              txHash: tx.hash
            });
            opportunities.push({ symbol, buyName, sellName, rawProfitUSDC, net });
            // save CSV incrementally
            saveCsvFile();
          }

        } catch (err) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}:`, err.reason || err.message || err);
          // continue to next pair safely
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} profitable executed/queued opportunities.\n`);
  return opportunities;
}

// ===== MAIN LOOP =====
async function mainLoop() {
  console.log("🚀 LIVE MODE ENABLED — FULL FAILSAFE CHECKS");
  console.log("🏛 Contract Address:", CONTRACT_ADDRESS);

  // Owner check (non-fatal if fails)
  try {
    const owner = await arbContract.owner();
    console.log("👤 Owner:", owner);
    const myAddr = await wallet.getAddress();
    if (owner.toLowerCase() !== myAddr.toLowerCase()) {
      console.warn("⚠ Wallet is not contract owner — callStatic/execute may revert. Make sure PRIVATE_KEY is contract owner.");
    }
  } catch (e) {
    console.warn("WARN: could not fetch contract owner:", e.message || e);
  }

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error("UNCAUGHT in scan loop:", e.stack || e.message || e);
      // save CSV on serious errors
      try { saveCsvFile(); } catch {}
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

// run
mainLoop().catch(err => {
  console.error("Fatal error:", err.stack || err.message || err);
  try { saveCsvFile(); } catch {}
  process.exit(1);
});
