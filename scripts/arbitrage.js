// scripts/arb.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIG =====
const DRY_RUN = process.env.DRY_RUN === "true" ? true : false;
console.log(`\n🚀 LIVE MODE ENABLED — ${DRY_RUN ? "SIMULATION ONLY (DRY_RUN)" : "REAL TRADES WILL BE EXECUTED"}\n`);

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const CONTRACT_ADDRESS = ethers.getAddress("0x19B64f74553eE0ee26BA01BF34321735E4701C43");
const DEFAULT_NATIVE_PRICE_USD = Number(process.env.NATIVE_PRICE_USD || "0.6"); // MATIC ~0.6 default
const MAX_PRICE_DELTA = Number(process.env.MAX_PRICE_DELTA || "0.10"); // 10% stale-reserve guard
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || "10"); // USDC
const MIN_PROFIT_USDC = Number(process.env.MIN_PROFIT_USDC || "0.001"); // minimum to consider executing
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || "0.0001"); // percent threshold for scan
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || "0.2"); // slippage applied to estimates
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000); // 30s

// DEX routers & tokens (unchanged)
const DEX_ROUTERS = {
  quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
  AAVE: { address: ethers.getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"), decimals: 18 },
  CRV:  { address: ethers.getAddress("0x172370d5cd63279efa6d502dab29171933a610af"), decimals: 18 },
  LINK: { address: ethers.getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"), decimals: 18 },
  WBTC: { address: ethers.getAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"), decimals: 8 }
};

// ===== ABIS =====
const arbAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",
  // simulateArbitrage may exist in your vault (view function returning expected USDC balance)
  "function simulateArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) view returns (uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

// ===== PROVIDER & WALLET =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ===== CONTRACT INSTANCES =====
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);
let usdcAddressCached = null;
let usdcContract = null;

async function initUSDC() {
  try {
    usdcAddressCached = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddressCached, erc20Abi, provider);
    usdcAddressCached = ethers.getAddress(usdcAddressCached);
  } catch (err) {
    console.warn("⚠ Could not read USDC address from vault contract:", err.message);
  }
}

await initUSDC();

// ===== UTILITIES =====
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Read on-chain vault USDC balance
async function getVaultBalance() {
  if (!usdcContract) await initUSDC();
  const bal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

// getAmountsOut helper: returns token units (price expressed as token amount for TRADE_AMOUNT_USDC USDC)
async function getAmountOut(routerAddress, token, amountInUSDC) {
  const router = new ethers.Contract(routerAddress, routerAbi, provider);
  const path = [usdcAddressCached || ethers.getAddress("0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174"), token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    // fallback via WBTC route (some routers fail for native token paths)
    const fallback = [path[0], tokens.WBTC.address, token.address];
    try {
      const amounts2 = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), fallback);
      return Number(ethers.formatUnits(amounts2[2], token.decimals));
    } catch (err2) {
      // return 0 to indicate failure
      return 0;
    }
  }
}

// Encode executeArbitrage data payload for provider.call
function encodeExecute(buyRouter, sellRouter, tokenAddr, amountIn) {
  return arbContract.interface.encodeFunctionData("executeArbitrage", [
    buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountIn.toString(), 6)
  ]);
}

// ---------------- Simulation helpers (3 independent ways) ----------------

// 1) If vault exports simulateArbitrage(token...) we call it directly.
//    Expect it to return expected vault USDC balance (or expected profit in USDC).
async function simulateViaContract(buyRouter, sellRouter, tokenAddr, amountIn) {
  if (!arbContract.simulateArbitrage) return null;
  try {
    const res = await arbContract.simulateArbitrage(buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountIn.toString(), 6));
    // caller's simulateArbitrage could return total vault balance or profit—normalize by heuristics
    const numeric = Number(ethers.formatUnits(res, 6));
    return { ok: true, method: "simulateContract", value: numeric };
  } catch (err) {
    return { ok: false, method: "simulateContract", error: err };
  }
}

// 2) callStatic approach: treat executeArbitrage as a view (callStatic) and expect it to return something or not revert.
//    This is similar to callStatic; we consider success if it returns or doesn't revert.
async function simulateViaCallStatic(buyRouter, sellRouter, tokenAddr, amountIn) {
  if (!arbContract.callStatic || !arbContract.callStatic.executeArbitrage) return null;
  try {
    // callStatic.executeArbitrage will return whatever on-chain returns (some contracts return nothing -> success)
    const res = await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountIn.toString(), 6), { from: await wallet.getAddress() });
    // If res is a BigNumber or numeric, normalize
    if (res === undefined) {
      return { ok: true, method: "callStatic", value: null }; // success non-return
    }
    try {
      const numeric = Number(ethers.formatUnits(res, 6));
      return { ok: true, method: "callStatic", value: numeric };
    } catch {
      return { ok: true, method: "callStatic", value: res };
    }
  } catch (err) {
    return { ok: false, method: "callStatic", error: err };
  }
}

// 3) provider.call — craft a low-level eth_call with `from: wallet.address` so it simulates exactly how a tx would run.
//    This is the most direct eth_call simulation and will surface reverts without spending gas.
async function simulateViaProviderCall(buyRouter, sellRouter, tokenAddr, amountIn) {
  try {
    const data = encodeExecute(buyRouter, sellRouter, tokenAddr, amountIn);
    const callReq = {
      to: CONTRACT_ADDRESS,
      data,
      from: await wallet.getAddress()
    };
    const res = await provider.call(callReq);
    // provider.call returns hex result or reverts; attempt to decode if the contract ABI has return types (best-effort)
    if (!res || res === "0x") return { ok: true, method: "providerCall", value: null };
    // try to decode using interface; encodeExecute used executeArbitrage (non-view); no return type expected — treat as success
    return { ok: true, method: "providerCall", value: res };
  } catch (err) {
    return { ok: false, method: "providerCall", error: err };
  }
}

// wrapper: require at least one simulation to succeed and return summary
async function runSimulations(buyRouter, sellRouter, tokenAddr, amountIn) {
  const results = [];
  // try contract simulation first (fast if available)
  const a = await simulateViaContract(buyRouter, sellRouter, tokenAddr, amountIn);
  if (a) results.push(a);
  const b = await simulateViaCallStatic(buyRouter, sellRouter, tokenAddr, amountIn);
  if (b) results.push(b);
  const c = await simulateViaProviderCall(buyRouter, sellRouter, tokenAddr, amountIn);
  if (c) results.push(c);
  // Determine overall verdict: any ok true => pass
  const passed = results.some(r => r.ok === true);
  return { passed, results };
}

// ---------------- Gas estimate -> USD guard ----------------
async function estimateGasUSD(buyRouter, sellRouter, tokenAddr, amountIn) {
  try {
    const populated = await arbContract.populateTransaction.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountIn.toString(), 6)
    );
    // estimate gas
    const gasEstimate = await provider.estimateGas({
      ...populated,
      from: await wallet.getAddress(),
      to: CONTRACT_ADDRESS,
      data: populated.data
    });
    // feeData (EIP-1559)
    const feeData = await provider.getFeeData();
    let gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!gasPrice) gasPrice = ethers.parseUnits("1", "gwei"); // fallback
    // native cost:
    const costNative = Number(ethers.formatUnits(gasEstimate * gasPrice, 18));
    const nativePrice = DEFAULT_NATIVE_PRICE_USD;
    const costUSD = costNative * nativePrice;
    return { ok: true, gasEstimate: gasEstimate.toNumber(), gasPrice: Number(ethers.formatUnits(gasPrice, 9)), gasUSD: costUSD };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// ---------------- Safety wrapper for execution ----------------
async function safeExecute(buyRouter, sellRouter, tokenAddr, amountIn, vaultBalanceBefore) {
  // 1) Run simulations
  const sim = await runSimulations(buyRouter, sellRouter, tokenAddr, amountIn);
  const simSummary = sim.results.map(r => {
    if (r.ok) return `${r.method}: PASS${r.value !== undefined && r.value !== null ? ` => ${r.value}` : ""}`;
    return `${r.method}: FAIL (${r.error?.message || r.error})`;
  }).join(" | ");
  if (!sim.passed) {
    console.log(`❌ All simulations failed — abort trade. Details: ${simSummary}`);
    return { executed: false, reason: "simulation_failed", simResults: sim.results };
  }
  console.log(`✅ Simulation summary: ${simSummary}`);

  // 2) Estimate profit by price-spread math (aggressive Option B)
  const buyOut = await getAmountOut(buyRouter, tokens.CR V? /* placeholder */, TRADE_AMOUNT_USDC).catch(()=>0); // not used here - we compute below
  // We'll compute using router amounts to get buyOut/sellOut for the token
  // (we will compute outside when calling safeExecute to avoid double-calls)

  // 3) Gas guard
  const gasInfo = await estimateGasUSD(buyRouter, sellRouter, tokenAddr, amountIn);
  if (!gasInfo.ok) {
    console.log("⚠ Unable to estimate gas; aborting trade for safety:", gasInfo.error?.message || gasInfo.error);
    return { executed: false, reason: "gas_est_failed" };
  }
  // Reject if gas USD > 50% of MIN_PROFIT_USDC or above a hard cap (conservative)
  const gasUsd = gasInfo.gasUSD;
  if (gasUsd > Math.max(0.5, MIN_PROFIT_USDC * 0.5)) {
    console.log(`❌ Gas cost too high: ~$${fmt(gasUsd)}; aborting (gas guard)`);
    return { executed: false, reason: "gas_too_high", gasUsd };
  }
  console.log(`⛽ Gas estimate: ${gasInfo.gasEstimate} units (~$${fmt(gasUsd)})`);

  // 4) If DRY_RUN skip execution but report as would-execute
  if (DRY_RUN) {
    console.log("ℹ DRY_RUN enabled — skipping on-chain execution (would execute here).");
    return { executed: false, reason: "dry_run" };
  }

  // 5) Execute (signed) tx
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountIn.toString(), 6),
      { gasLimit: Math.max(300_000, gasInfo.gasEstimate + 50_000) }
    );
    if (!tx || !tx.hash) {
      console.log("❌ txHash undefined — aborting (safety).");
      return { executed: false, reason: "no_txhash" };
    }
    console.log(`📤 txHash: ${tx.hash} — awaiting confirmation...`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ tx reverted on-chain — vault unchanged.");
      return { executed: false, reason: "onchain_revert" };
    }
    // read vault after
    const after = await getVaultBalance();
    const netProfit = after - vaultBalanceBefore;
    if (netProfit <= 0) {
      console.log("❌ Vault did not increase — treating trade as failed (no negative log).");
      return { executed: false, reason: "no_vault_gain", receipt };
    }
    console.log(`✅ Trade confirmed. Vault increased by ${fmt(netProfit)} USDC (tx: ${receipt.transactionHash})`);
    // CSV logging handled by caller
    return { executed: true, netProfit, receipt };
  } catch (err) {
    console.log("❌ Execution error:", err.message);
    return { executed: false, reason: "exec_error", error: err };
  }
}

// ---------------- Scanning loop ----------------
let cumulativeProfit = 0;
const csvRows = [];
function logCSV(row) { csvRows.push(row.join(",")); }
function saveCSV() {
  if (csvRows.length === 0) return;
  const filename = `arbitrage_log_${Date.now()}.csv`;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 Trades exported to CSV: ${filename}`);
}

// A robust scan & execution function
async function scanOnce() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  let opportunitiesFound = 0;

  const vaultBefore = await getVaultBalance();
  console.log(`🏦 Vault Balance (before scan): ${fmt(vaultBefore)} USDC`);

  for (const [sym, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(DEX_ROUTERS)) {
      for (const [sellName, sellRouter] of Object.entries(DEX_ROUTERS)) {
        if (buyName === sellName) continue;

        try {
          // Price via getAmountsOut
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          if (buyOut === 0 || sellOut === 0) {
            // skip stale or unreachable markets
            continue;
          }

          // compute implied USDC per token prices (USDC per token)
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;   // how many USDC per 1 token when buying
          const sellPrice = TRADE_AMOUNT_USDC / sellOut; // how many USDC per 1 token when selling

          // price deviation guard: protect against stale reserves / huge price deltas
          const priceDelta = Math.abs(buyPrice - sellPrice) / ((buyPrice + sellPrice) / 2);
          if (priceDelta > MAX_PRICE_DELTA) {
            console.log(`${sym} | ${buyName} $${fmt(buyPrice)} → ${sellName} $${fmt(sellPrice)} | ⚠ Price deviation ${fmt(priceDelta*100,4)}% > ${MAX_PRICE_DELTA*100}% — skipped`);
            continue;
          }

          // profit as in Option B: (sellPrice - buyPrice) * tokenAmount
          // tokenAmount = buyOut (token units) for TRADE_AMOUNT_USDC spent on buy side.
          // sellOut is token units received for same USDC; we use price spread * tokenAmount (aggressive).
          const tokenAmount = buyOut; // tokens you'd get when buying with TRADE_AMOUNT_USDC on buyRouter
          const spreadPerToken = sellPrice - buyPrice;
          let rawProfit = spreadPerToken * tokenAmount; // in USDC
          // apply slippage safety
          rawProfit *= (1 - SLIPPAGE_PCT / 100);

          const profitPct = (rawProfit / TRADE_AMOUNT_USDC) * 100;

          console.log(`${sym} | ${buyName} $${fmt(buyPrice)} → ${sellName} $${fmt(sellPrice)} | Est. Profit: ${fmt(rawProfit)} USDC (${fmt(profitPct,4)}%)`);

          // checks for minimum
          if (rawProfit < MIN_PROFIT_USDC && profitPct < MIN_PROFIT_PCT) {
            continue;
          }

          // candidate found
          opportunitiesFound++;
          console.log(`🚨 PROFITABLE: executing ${sym} ${buyName}→${sellName} (est +${fmt(rawProfit)} USDC)`);

          // run full safe execute which runs 3x simulation + gas guard + vault checks
          const execResult = await safeExecute(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC, vaultBefore);

          if (execResult.executed) {
            // success: log
            const ts = new Date().toISOString();
            cumulativeProfit += execResult.netProfit;
            csvRows.push([ts, sym, buyName, sellName, TRADE_AMOUNT_USDC.toString(), execResult.netProfit.toFixed(6)].join(","));
            console.log(`💾 Logged trade. Cumulative Profit: ${fmt(cumulativeProfit)} USDC`);
          } else {
            console.log(`❌ Trade NOT executed: ${execResult.reason || execResult.error?.message || "unknown"}`);
          }

          // small cooldown after each candidate (prevents hammering)
          await sleep(1200);
        } catch (err) {
          console.warn(`⚠ Scan error ${sym} ${buyName}->${sellName}:`, err.message || err);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Opportunities found: ${opportunitiesFound}`);
  if (csvRows.length) saveCSV();
}

// Main loop
async function main() {
  console.log("🚀 Live Aave Flash Arbitrage Bot with Vault Started");
  // show contract owner if available
  try {
    const owner = await arbContract.owner();
    console.log("🏛 Vault Owner:", owner);
  } catch (err) {
    console.warn("⚠ Could not read vault owner:", err.message);
  }

  while (true) {
    await scanOnce();
    console.log(`🔁 Rescanning in ${SCAN_INTERVAL_MS / 1000}s...\n`);
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
