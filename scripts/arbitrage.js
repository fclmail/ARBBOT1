// scripts/arbitrage.js
// 🔹 AAVE FLASH ARB BOT — Polygon (complete, signer + callStatic + gas/contract balance logging)
// Drop-in replacement for your previous arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in env");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // hardcoded contract
const SCAN_INTERVAL_MS = 40_000; // 40 seconds
const TRADE_AMOUNT_USDC = .007; // human USDC amount
const MIN_PROFIT_PCT = 3; // percent
const SLIPPAGE_PCT = 0; // percent assumed for calculation (adjust if desired)
const MIN_WALLET_MATIC = 0.001; // minimal MATIC to allow tx (safety)
const MATIC_USD_PRICE = process.env.MATIC_USD_PRICE ? Number(process.env.MATIC_USD_PRICE) : null; // optional

console.log("RPC_URL:", RPC_URL);
console.log("PRIVATE_KEY:", PRIVATE_KEY ? "[OK]" : "[MISSING]");
console.log("CONTRACT_ADDRESS:", CONTRACT_ADDRESS);

// ─────────────── PROVIDER / WALLET / CONTRACT ───────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ABI (as provided)
const arbAbi = [
  { "inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],"name":"executeArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function" },
  { "inputs":[{"internalType":"address","name":"asset","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"address","name":"","type":"address"},{"internalType":"bytes","name":"params","type":"bytes"}],"name":"executeOperation","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function" },
  {"inputs":[{"internalType":"uint256","name":"_minProfit","type":"uint256"}],"name":"setMinProfit","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"AAVE_POOL","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"minProfit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"USDC","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"token","type":"address"}],"name":"withdrawProfit","outputs":[],"stateMutability":"nonpayable","type":"function"}
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS (normalize / skip invalid) ───────────────
const routerRaw = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routers = {};
for (const [k, v] of Object.entries(routerRaw)) {
  try {
    routers[k] = ethers.getAddress(v);
  } catch (e) {
    console.warn(`⚠️ Skipping invalid router address for ${k}: ${v}`);
  }
}

// ─────────────── TOKENS (normalize) ───────────────
const tokenRaw = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:  { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

const tokens = {};
for (const [s, t] of Object.entries(tokenRaw)) {
  try {
    tokens[s] = { address: ethers.getAddress(t.address), decimals: t.decimals };
  } catch (e) {
    console.warn(`⚠️ Skipping invalid token address: ${t.address}`);
  }
}

// ─────────────── SETTINGS / HELPERS ───────────────
function fmt(n, d = 6) { return Number(n).toFixed(d); }

async function providerGasPrice() {
  const fee = await provider.getFeeData();
  // prefer gasPrice then maxFeePerGas
  return fee.gasPrice ?? fee.maxFeePerGas ?? BigInt(0);
}

// getAmountsOut from a router (amountIn is human USDC)
async function getAmountOut(routerAddr, token, amountInHuman) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdcAddr = await arbContract.USDC();
  const path1 = [usdcAddr, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInHuman.toString(), 6), path1);
    const out = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(out, token.decimals));
  } catch {
    // fallback via WETH
    const path2 = [usdcAddr, tokens.WETH.address, token.address];
    try {
      const amounts = await router.getAmountsOut(ethers.parseUnits(amountInHuman.toString(), 6), path2);
      const out = amounts[amounts.length - 1];
      return Number(ethers.formatUnits(out, token.decimals));
    } catch (e) {
      // failed
      return NaN;
    }
  }
}

// ─────────────── SANITY CHECKS AT START ───────────────
async function sanityChecks() {
  console.log("🔎 Running startup sanity checks...");
  // contract method
  if (typeof arbContract.executeArbitrage !== "function") {
    console.error("❌ ABI mismatch: arbContract.executeArbitrage is not a function");
    return false;
  }

  // check owner
  try {
    const owner = await arbContract.owner();
    console.log("👤 Contract owner:", owner);
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error("❌ Wallet is not contract owner — executeArbitrage will revert. Use owner key.");
      return false;
    }
  } catch (e) {
    console.warn("⚠️ Could not read owner():", e.message || e);
    // continue — but warn
  }

  // check wallet MATIC
  const maticBal = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
  console.log("⛽ Wallet MATIC balance:", fmt(maticBal, 6), "MATIC");
  if (maticBal < MIN_WALLET_MATIC) {
    console.error(`❌ Wallet MATIC < ${MIN_WALLET_MATIC}. Top up to pay gas.`);
    return false;
  }

  // check contract USDC address exists
  try {
    const usdcAddr = await arbContract.USDC();
    console.log("💵 Contract USDC token address:", usdcAddr);
  } catch (e) {
    console.error("❌ Cannot read USDC() from contract:", e.message || e);
    return false;
  }

  console.log("✅ Sanity checks passed.");
  return true;
}

// ─────────────── EXECUTE TRADE (callStatic -> estimate -> send) ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountHumanUSDC) {
  try {
    // confirm function exists
    if (typeof arbContract.executeArbitrage !== "function") {
      throw new Error("arbContract.executeArbitrage not available (ABI/contract mismatch)");
    }

    // wallet must be owner (double-check)
    try {
      const owner = await arbContract.owner();
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(`Wallet (${wallet.address}) is not contract owner (${owner})`);
      }
    } catch (e) {
      throw new Error("Could not verify owner: " + (e.message || e));
    }

    // get USDC token contract and contract balance before
    const usdcAddr = await arbContract.USDC();
    const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
    const beforeBalRaw = await usdc.balanceOf(CONTRACT_ADDRESS);
    const beforeBal = Number(ethers.formatUnits(beforeBalRaw, 6));

    // callStatic simulation
    try {
      await arbContract.callStatic.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountHumanUSDC.toString(), 6)
      );
    } catch (simErr) {
      throw new Error("callStatic simulation reverted: " + (simErr.reason || simErr.message || simErr));
    }

    // populate transaction to estimate gas
    const populated = await arbContract.populateTransaction.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountHumanUSDC.toString(), 6)
    );

    // estimateGas with wallet
    let gasEstimate;
    try {
      gasEstimate = await wallet.estimateGas({ to: CONTRACT_ADDRESS, data: populated.data });
    } catch (gErr) {
      throw new Error("estimateGas failed: " + (gErr.reason || gErr.message || gErr));
    }

    const gasPrice = await providerGasPrice();
    const gasCostWei = gasEstimate * gasPrice;
    const gasCostMatic = Number(ethers.formatUnits(gasCostWei, 18));
    const gasPriceGwei = Number(ethers.formatUnits(gasPrice, "gwei"));

    // optional approximate convert to USDC if price provided
    const gasCostUSDCApprox = MATIC_USD_PRICE ? gasCostMatic * MATIC_USD_PRICE : null;

    console.log(`💸 Estimated gas: ${gasEstimate.toString()} | gasPrice: ${fmt(gasPriceGwei,4)} gwei => ~${fmt(gasCostMatic,6)} MATIC${gasCostUSDCApprox ? ` ≈ ${fmt(gasCostUSDCApprox,6)} USDC` : ""}`);

    // ensure wallet has enough MATIC
    const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
    if (walletMatic < gasCostMatic * 1.05) {
      throw new Error(`insufficient wallet MATIC for gas: have ${fmt(walletMatic,6)} MATIC need ~${fmt(gasCostMatic,6)} MATIC`);
    }

    // send transaction (buffer gas limit)
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountHumanUSDC.toString(), 6),
      { gasLimit: gasEstimate.mul(2) }
    );
    console.log(`⏳ Trade tx sent: ${tx.hash} — waiting for confirmation...`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined: ${tx.hash} | block ${receipt.blockNumber} | gasUsed: ${receipt.gasUsed.toString()}`);

    // after: contract USDC balance
    const afterBalRaw = await usdc.balanceOf(CONTRACT_ADDRESS);
    const afterBal = Number(ethers.formatUnits(afterBalRaw, 6));
    const netChange = afterBal - beforeBal;

    console.log(`🏦 Contract USDC before: ${fmt(beforeBal,6)} | after: ${fmt(afterBal,6)} | net change: ${fmt(netChange,6)} USDC`);
    return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed, netChange };

  } catch (err) {
    console.error("⚠️ Trade failed or reverted:", err.message || err);
    return { success: false, error: (err.message || String(err)) };
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scanOnce() {
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];
  // get usdc address early (used by getAmountOut)
  let usdcAddr;
  try { usdcAddr = await arbContract.USDC(); } catch (e) { console.warn("⚠️ Could not read USDC() from contract:", e.message || e); }

  for (const [sym, token] of Object.entries(tokens)) {
    // skip tokens lacking normalization
    if (!token || !token.address) continue;

    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        if (!buyRouter || !sellRouter) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          // sanity filters:
          if (!Number.isFinite(buyOut) || !Number.isFinite(sellOut) || buyOut <= 0 || sellOut <= 0) {
            // skip silently if not tradable on that route
            // console.warn(`⚠️ Skipping unrealistic amountOut (buyOut=${buyOut}, sellOut=${sellOut}) for ${sym} ${buyName}->${sellName}`);
            continue;
          }
          if (buyOut > 1e9 || sellOut > 1e12) continue; // ridiculous values

          // compute buy/sell price (USDC per token using TRADE_AMOUNT_USDC)
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;
          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

          // require minimal percent
          if (profitPct >= MIN_PROFIT_PCT) {
            // log detailed opportunity
            console.log(`\n🚨 ${sym} | Buy:${buyName} @ $${fmt(buyPrice,6)} → Sell:${sellName} @ $${fmt(sellPrice,6)} | Estimated gross profit: ${fmt(profitUSDC,6)} USDC (${fmt(profitPct,2)}%)`);
            console.log(`🔹 Opportunity: Buy on ${buyRouter} / Sell on ${sellRouter}`);
            console.log(`🔸 Token: ${token.address}`);
            console.log(`🔸 Buy price: $${fmt(buyPrice,6)} | Sell price: $${fmt(sellPrice,6)}`);
            console.log(`🔸 Estimated gross profit: ${fmt(profitUSDC,6)} USDC`);

            // estimate gas + net profit before sending
            // Use populateTransaction + estimateGas inside executeTrade, but we can pre-estimate quickly:
            // We will attempt a simulation and only then send.
            const result = await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
            if (result.success) {
              console.log(`🔍 Scan pass: trade executed, contract credited ${fmt(result.netChange,6)} USDC\n`);
            } else {
              console.log(`⚠️ Execution skipped/failed for ${sym} ${buyName}->${sellName}: ${result.error}\n`);
            }

            // record found opportunity
            opportunities.push({ token: sym, buyName, sellName, buyPrice, sellPrice, profitUSDC, profitPct });
          }
        } catch (e) {
          console.warn(`⚠️ Error scanning ${sym} ${buyName}->${sellName}: ${e.message || e}`);
          // continue scanning other pairs
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.`);
  return opportunities;
}

// ─────────────── MAIN ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  console.log("🟢 Contract:", CONTRACT_ADDRESS);
  // startup checks
  const ok = await sanityChecks();
  if (!ok) {
    console.error("❌ Sanity checks failed. Exiting.");
    process.exit(1);
  }

  // main loop
  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.error("⚠️ Unhandled scan error:", e.message || e);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

