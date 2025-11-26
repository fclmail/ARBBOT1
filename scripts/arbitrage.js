// improved-arbitrage.js (patched - no external API keys required)
import { ethers, Wallet, Interface } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true";
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// stricter, profit-first defaults for aggressive-but-defensive mode
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.5);     // % over buy price
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 1.0);     // start higher for safety
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.005);      // conservative gas (USDC)
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.0001);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.3);         // allow a bit more margin
const STABILITY_SAMPLES = Number(process.env.STABILITY_SAMPLES || 3);
const STABILITY_DELAY_MS = Number(process.env.STABILITY_DELAY_MS || 150);

// ---------- ROUTERS & TOKENS (restricted whitelist - polygon deep pools) ----------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  // remove unnecessary routers to reduce noise; add more if you trust them
};

// Whitelisted tokens: deep liquid assets on Polygon (verify addresses before use)
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ABIs ----------
// Keep original ABI (4-arg) but prepare an Interface for 5-arg version to encode minReturn if contract supports it.
const arbAbi4 = [
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
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
];

const arbAbi5 = [
  // same as 4 but with minReturnUSDC added
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
      { "internalType": "uint256", "name": "minReturnUSDC", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi4, provider) : new ethers.Contract(CONTRACT_ADDRESS, arbAbi4, wallet);
const arbInterface5 = new Interface(arbAbi5.map(f => f)); // for encoding/decoding with minReturn if available
const arbInterface4 = new Interface(arbAbi4);

// USDC ERC20 helper - we'll initialize in init()
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

// ---------- INIT ----------
async function init() {
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
    console.log("💱 Using USDC token at:", usdcAddr);
  } catch (e) {
    console.warn("⚠️ Initialization warning:", e.message);
  }
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

// getAmountsOut wrapper (returns BigNumber array result)
async function getAmountsOutRaw(routerAddr, path, amountInUnits) {
  const router = new ethers.Contract(routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  return await router.getAmountsOut(amountInUnits, path);
}

// wrapper that returns numeric token out based on path inference
async function getAmountOut(routerAddr, token, amountUSDC) {
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  try {
    const amounts = await getAmountsOutRaw(routerAddr, path, ethers.parseUnits(amountUSDC.toString(), 6));
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch (err) {
    // fallback path attempt via WBTC
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await getAmountsOutRaw(routerAddr, fallback, ethers.parseUnits(amountUSDC.toString(), 6));
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// compute conservative round-trip minReturnUSDC (returns BigNumber in 6 decimals)
async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC) {
  const usdcAddr = await arbContract.USDC();
  const amountInUnits = ethers.parseUnits(amountUSDC.toString(), 6);

  // 1) buy path: USDC -> token
  let buyAmounts;
  try {
    buyAmounts = await getAmountsOutRaw(buyRouter, [usdcAddr, tokenObj.address], amountInUnits);
  } catch (e) {
    try {
      buyAmounts = await getAmountsOutRaw(buyRouter, [usdcAddr, tokens.WBTC.address, tokenObj.address], amountInUnits);
    } catch (e2) {
      return ethers.parseUnits("0", 6);
    }
  }
  const tokenAmountBn = buyAmounts[buyAmounts.length - 1];

  // 2) sell path: token -> USDC
  let sellAmounts;
  try {
    sellAmounts = await getAmountsOutRaw(sellRouter, [tokenObj.address, usdcAddr], tokenAmountBn);
  } catch (e) {
    // if cannot estimate sell output, return 0 (not tradable)
    return ethers.parseUnits("0", 6);
  }

  const expectedUSDCAfter = Number(ethers.formatUnits(sellAmounts[sellAmounts.length - 1], 6));

  // safety multiplier: slippage allowance + tiny extra buffer
  const safetyMultiplier = Math.max(0, 1 - (SLIPPAGE_PCT / 100) - 0.0025); // extra 0.25% buffer
  const minReturn = expectedUSDCAfter * safetyMultiplier;

  return ethers.parseUnits(minReturn.toFixed(6), 6);
}

// price sanity check
async function priceSanityCheck(routerAddr, token, amountUSDC) {
  try {
    const out = await getAmountOut(routerAddr, token, amountUSDC);
    return out > 0 && Number.isFinite(out);
  } catch (e) {
    return false;
  }
}

// multi-sample stability check
async function stablePriceCheck(routerAddr, token, amountUSDC) {
  try {
    const samples = [];
    for (let i = 0; i < STABILITY_SAMPLES; i++) {
      const out = await getAmountOut(routerAddr, token, amountUSDC);
      samples.push(out);
      if (i < STABILITY_SAMPLES - 1) await new Promise(r => setTimeout(r, STABILITY_DELAY_MS));
    }
    const max = Math.max(...samples);
    const min = Math.min(...samples);
    // require < 4% intra-sample variation
    return (max / min) < 1.04;
  } catch (e) {
    return false;
  }
}

// median price across routers (USDC per token)
async function getMedianRouterPrice(token, amountUSDC) {
  const prices = [];
  const usdcAddr = await arbContract.USDC();
  for (const r of Object.values(routers)) {
    try {
      const out = await getAmountOut(r, token, amountUSDC);
      if (out && out > 0) {
        prices.push(amountUSDC / out);
      }
    } catch (e) { /* ignore */ }
  }
  if (prices.length === 0) return null;
  prices.sort((a,b) => a - b);
  return prices[Math.floor(prices.length / 2)];
}

// compute gas conservative check (we only compare expectedProfitUSDC to GAS_EST_USDC)
async function conservativeGasGuard(expectedProfitUSDC) {
  if (expectedProfitUSDC <= GAS_EST_USDC) return false;
  return true;
}

// helper: check if contract likely supports the 5-arg signature (no onchain call)
function supportsMinReturnInterface() {
  try {
    // if arbInterface5 can encode, that's enough; existence of function on-chain will be validated via provider.call
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- CORE: executeTradeLive with enhanced checks ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase());
  if (!tokenObj) {
    console.log("⛔️ Token not whitelisted — skipping");
    return;
  }

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    // 1) Vault balance before
    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    // 2) Quick sanity: amount must be >= MIN_TRADE_USDC
    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC ${MIN_TRADE_USDC}`);
      return;
    }

    // 3) Pre-profit check using on-chain getAmountsOut (no tx)
    let buyOut, sellOut;
    try {
      buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
      sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
    } catch (err) {
      console.log("⚠️ Pre-price query failed — aborting trade:", err.message);
      return;
    }

    // implied prices (USDC per token)
    const buyPrice  = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    let expectedProfitUSDC = (sellPrice - buyPrice);
    // apply slippage guard
    expectedProfitUSDC *= (1 - SLIPPAGE_PCT/100);

    console.log(`📈 Quoted: buyPrice=${fmt(buyPrice,6)} | sellPrice=${fmt(sellPrice,6)} | expectedProfit=${fmt(expectedProfitUSDC,6)} USDC (after ${SLIPPAGE_PCT}% slippage)`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      console.log(`❌ PREVENTED — Expected profit ${fmt(expectedProfitUSDC)} <= MIN_EXPECTED_PROFIT ${MIN_EXPECTED_PROFIT}`);
      return;
    }

    // 4) Median/market sanity
    const medianPrice = await getMedianRouterPrice(tokenObj, amountUSDC);
    if (medianPrice) {
      if (sellPrice < medianPrice * 0.995) {
        console.log("⚠️ Sell price is below median market price — skipping (possible spoof)");
        return;
      }
      if (buyPrice > medianPrice * 1.005) {
        console.log("⚠️ Buy price is above median market price — skipping (possible spoof)");
        return;
      }
    }

    // 5) stability + liquidity checks
    if (!await stablePriceCheck(buyRouter, tokenObj, amountUSDC) || !await stablePriceCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price unstable across quick samples — skipping");
      return;
    }
    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) || !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed — possible illiquid pair — aborting");
      return;
    }

    // 6) gas conservative guard
    if (!await conservativeGasGuard(expectedProfitUSDC)) {
      console.log(`❌ PREVENTED — expectedProfit ${fmt(expectedProfitUSDC)} ≤ GAS_EST_USDC ${GAS_EST_USDC} (conservative)`);
      return;
    }

    // 7) compute minReturnUSDC (conservative roundtrip)
    const minReturnBN = await computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC);
    const minReturnFloat = Number(ethers.formatUnits(minReturnBN, 6));
    console.log(`🧮 Computed minReturnUSDC (conservative): ${fmt(minReturnFloat)} USDC`);

    // require that minReturn is greater than before + min profit threshold (script-level)
    const requiredMin = before + Math.max(MIN_EXPECTED_PROFIT, (buyPrice * (MIN_PROFIT_PCT/100))); // rough
    if (minReturnFloat <= requiredMin) {
      console.log(`❌ MIN RETURN too low relative to required profit (${fmt(requiredMin)} USDC) — aborting`);
      return;
    }

    // 8) simulate (callStatic/provider.call) using 5-arg signature if possible
    // Prepare data for 5-arg encoding
    const encoded5 = arbInterface5.encodeFunctionData("executeArbitrage", [
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6), minReturnBN
    ]);

    let simulationOk = false;
    try {
      // provider.call uses the 5-arg encoding; if contract doesn't recognize it, this will revert
      await provider.call({ to: CONTRACT_ADDRESS, data: encoded5, from: wallet ? wallet.address : undefined });
      console.log("🔬 Simulation OK — contract (5-arg) would accept minReturn");
      simulationOk = true;
    } catch (simErr5) {
      // If 5-arg simulation fails, try 4-arg simulation (older contract)
      console.log("⚠️ 5-arg simulation failed (contract might not support minReturn) — trying 4-arg callStatic...");
      try {
        // use contract's callStatic if available
        if (arbContract.callStatic && arbContract.callStatic.executeArbitrage) {
          await arbContract.callStatic.executeArbitrage(
            buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6),
            { from: wallet ? wallet.address : undefined }
          );
          console.log("🔬 4-arg callStatic simulation OK — contract call would not revert");
          simulationOk = true;
        } else {
          // fallback to provider.call encoding 4-arg
          const encoded4 = arbInterface4.encodeFunctionData("executeArbitrage", [
            buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6)
          ]);
          await provider.call({ to: CONTRACT_ADDRESS, data: encoded4, from: wallet ? wallet.address : undefined });
          console.log("🔬 4-arg simulation OK (provider.call)");
          simulationOk = true;
        }
      } catch (simErr4) {
        console.log("❌ SIMULATION FAILED — contract would revert:", (simErr4 && simErr4.message) ? simErr4.message.split("\n")[0] : simErr5.message.split("\n")[0]);
        console.log("❌ Trade aborted — vault remains unchanged (no gas spent)");
        return;
      }
    }

    if (!simulationOk) {
      console.log("❌ Simulation not OK — aborting");
      return;
    }

    // 9) DRY_RUN check
    if (DRY_RUN) {
      console.log("🧪 DRY_RUN: simulation passed but not sending tx (stopping here).");
      return;
    }

    // 10) Execute transaction (prefer 5-arg if contract supports it)
    console.log("🚀 Executing arbitrage (on-chain) — sending tx...");
    let tx;
    try {
      // If the contract supports minReturn, call with 5 args, otherwise fallback to 4-arg old call.
      try {
        // attempt 5-arg call first (if simulation previously succeeded for 5-arg)
        tx = await wallet.sendTransaction({
          to: CONTRACT_ADDRESS,
          data: encoded5,
          gasLimit: undefined // let provider estimate, but you can set gasEstimate buffer earlier if desired
        });
      } catch (err5) {
        // fallback: use contract method (4-arg)
        console.log("⚠️ Fallback to 4-arg executeArbitrage (contract may be old) — sending tx");
        tx = await arbContract.executeArbitrage(
          buyRouter,
          sellRouter,
          tokenAddr,
          ethers.parseUnits(amountUSDC.toString(), 6),
          { gasLimit: undefined }
        );
      }
    } catch (sendErr) {
      console.error("❌ Failed to send tx:", sendErr.message);
      return;
    }

    if (!tx || !tx.hash) {
      console.error("❌ Tx did not return a hash — aborting post-checks. Vault unchanged.");
      return;
    }
    console.log(`🔁 TX SENT — hash: ${tx.hash} — waiting for confirmation...`);

    // 11) Wait for receipt + verify status
    const receipt = await tx.wait();
    if (!receipt || (!('status' in receipt) ? false : receipt.status === 0)) {
      console.log("❌ Transaction reverted or failed on-chain — vault unchanged");
      return;
    }
    console.log(`✅ Transaction success — txHash ${receipt.transactionHash} • gasUsed ${receipt.gasUsed?.toString() || "n/a"}`);

    // 12) After-trade vault balance verification
    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    console.log(`🏦 Vault Balance After: ${fmt(after)} USDC`);

    if (after <= before) {
      console.log("❌ Trade resulted in no net vault increase — treated as failed/ignored");
      return;
    }

    // 13) Real net profit (+ logging)
    const netProfit = after - before;
    console.log(`💰 REAL Net Profit This Trade: ${fmt(netProfit)} USDC`);
    cumulativeProfit += netProfit;
    console.log(`📊 Cumulative Profit: ${fmt(cumulativeProfit)} USDC`);

    // 14) Persist the trade to CSV
    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({
      timestamp,
      symbol,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profitUSDC: netProfit
    });
    console.log("🗂 Trade logged to CSV buffer");

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message || err);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || MIN_TRADE_USDC);
async function scanOnce() {
  console.log("\n🔍 Scanning for arbitrage opportunities...");
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
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          let profitPct = (profitUSDC / buyPrice) * 100;

          console.log(`${symbol} | ${buyName} → ${sellName} | buy=${fmt(buyPrice)} sell=${fmt(sellPrice)} | profit=${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 PROFITABLE: ${symbol} | ${buyName} → ${sellName} | est ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);
            opportunities.push({ symbol, tokenAddr: token.address, buyRouter, sellRouter, buyName, sellName, profitUSDC });
            // execute with internal checks in executeTradeLive
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn(`⚠️ Scan error for ${symbol} ${buyName}->${sellName}:`, e.message || e);
        }
      }
    }
  }

  saveCSV();
  console.log(`🔍 Scan complete — found ${opportunities.length} candidate opportunities.`);
  return opportunities;
}

// ---------- MAIN ----------
(async function main(){
  await init();
  console.log("🚀 Improved arbitrage runner started");
  try {
    await scanOnce();
  } catch (e) {
    console.error("Fatal scanner error:", e.message || e);
  }
})();
