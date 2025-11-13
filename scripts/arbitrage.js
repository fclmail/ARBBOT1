// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in environment");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// -- addresses you provided (hardcoded) --
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6 decimals
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

// WMATIC (Polygon) for gas->USDC conversion
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

// Routers (we will normalize and skip invalid)
const ROUTER_INPUT = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens scanned (subset). decimals provided.
const TOKEN_INPUT = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:  { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

// Settings
const TRADE_AMOUNT_USDC = .5;   // human units
const MIN_PROFIT_PCT = 3;       // % required (gross) before considering gas
const SLIPPAGE_PCT = 0;         // apply slippage factor to profit estimate
const SCAN_INTERVAL_MS = 40_000; // 40 seconds

// ---------------- ABI & Contract ----------------
const arbAbi = [
  // only the functions we use
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)"
];
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ---------------- normalize routers & tokens (skip bad) ----------------
const routers = {};
for (const [k, v] of Object.entries(ROUTER_INPUT)) {
  try {
    routers[k] = ethers.getAddress(v);
  } catch (e) {
    console.warn(`⚠️ Skipping invalid router address for ${k}: ${v}`);
  }
}

const tokens = {};
for (const [sym, obj] of Object.entries(TOKEN_INPUT)) {
  try {
    tokens[sym] = { address: ethers.getAddress(obj.address), decimals: obj.decimals };
  } catch {
    console.warn(`⚠️ Skipping invalid token address for ${sym}: ${obj.address}`);
  }
}

// ---------------- helpers ----------------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountInHuman) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  // path: USDC -> token or USDC->WETH->token fallback
  const usdc = USDC_ADDRESS;
  const amountIn = ethers.parseUnits(amountInHuman.toString(), 6);
  try {
    const path = [usdc, token.address];
    const amounts = await router.getAmountsOut(amountIn, path);
    const out = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(out, token.decimals));
  } catch {
    try {
      const path2 = [usdc, WMATIC, token.address];
      const amounts2 = await router.getAmountsOut(amountIn, path2);
      const out = amounts2[amounts2.length - 1];
      return Number(ethers.formatUnits(out, token.decimals));
    } catch (err) {
      // propagate for caller to handle
      throw new Error(`getAmountOut failed for router ${routerAddr}: ${err.message || err}`);
    }
  }
}

// use QuickSwap to convert MATIC -> USDC (1 MATIC)
async function getMaticPriceInUSDC() {
  const quick = routers.QuickSwap;
  if (!quick) return null;
  try {
    const router = new ethers.Contract(quick, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const amounts = await router.getAmountsOut(ethers.parseUnits("1", 18), [WMATIC, USDC_ADDRESS]);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], 6)); // USDC value for 1 MATIC
  } catch {
    return null;
  }
}

// gas MATIC -> USDC helper
async function gasCostToUSDC(gasWeiBig, gasPriceWei) {
  // gasWeiBig: gas units (BigInt), gasPriceWei: BigInt
  const totalWei = gasWeiBig * gasPriceWei; // BigInt
  // total MATIC = totalWei / 1e18
  const totalMATIC = Number(ethers.formatUnits(totalWei, 18));
  const maticToUSDC = await getMaticPriceInUSDC();
  if (maticToUSDC != null) {
    return { matic: totalMATIC, usdc: totalMATIC * maticToUSDC };
  }
  return { matic: totalMATIC, usdc: null };
}

// ---------------- core: executeTrade ----------------
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountHuman) {
  try {
    // get contract USDC balance before
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
    const beforeBalRaw = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const beforeBal = Number(ethers.formatUnits(beforeBalRaw, 6));

    // populate tx
    const populated = await arbContract.populateTransaction.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountHuman.toString(), 6)
    );

    // estimate gas
    let gasEstimate;
    try {
      gasEstimate = await wallet.estimateGas({ to: CONTRACT_ADDRESS, data: populated.data });
    } catch (err) {
      // if estimateGas fails, log and abort execution
      console.warn("⚠️ estimateGas failed:", err.message || err);
      throw new Error("Gas estimate failed, aborting execution.");
    }

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas; // BigInt
    if (!gasPrice) throw new Error("Cannot fetch gas price");

    // compute estimated gas cost
    const estInfo = await gasCostToUSDC(gasEstimate, gasPrice);
    console.log(`💸 Estimated gas: ${fmt(estInfo.matic,6)} MATIC ${estInfo.usdc ? `≈ ${fmt(estInfo.usdc,6)} USDC` : ""} (gasPrice: ${ethers.formatUnits(gasPrice, 9)} gwei, gasEstimate: ${gasEstimate.toString()})`);

    // Ensure gross profit > gas + buffer
    // We will compute estimated gross profit outside (caller)
    // Simulate call with callStatic to ensure it won't revert (safety)
    try {
      await arbContract.callStatic.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountHuman.toString(), 6), { gasLimit: gasEstimate }
      );
    } catch (callErr) {
      // callStatic revert provides reason; we surface it and abort
      console.warn("⚠️ callStatic simulation reverted — skipping execution. reason:", (callErr.error && callErr.error.message) || callErr.reason || callErr.message || callErr);
      return { executed: false, reason: "callStatic reverted", callErr };
    }

    // send tx (use a buffer to gasLimit)
    const gasBuffer = gasEstimate.mul(ethers.BigInt(2)); // safety
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountHuman.toString(), 6),
      { gasLimit: gasBuffer }
    );

    console.log(`⏳ Trade tx sent: ${tx.hash} — waiting for confirmation...`);
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed ?? gasEstimate;
    const actualGasInfo = await gasCostToUSDC(gasUsed, gasPrice);

    // USDC balance after
    const afterBalRaw = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const afterBal = Number(ethers.formatUnits(afterBalRaw, 6));
    const netChange = afterBal - beforeBal; // positive means contract gained USDC

    console.log(`✅ Tx mined in block ${receipt.blockNumber} | gasUsed: ${gasUsed.toString()}`);
    console.log(`🏦 Contract USDC balance (before): ${fmt(beforeBal,6)} USDC`);
    console.log(`🏦 Contract USDC balance (after):  ${fmt(afterBal,6)} USDC`);
    console.log(`💹 Net USDC change for contract this tx: ${fmt(netChange,6)} USDC`);
    console.log(`⛽ Actual gas used: ${fmt(actualGasInfo.matic,6)} MATIC ${actualGasInfo.usdc ? `≈ ${fmt(actualGasInfo.usdc,6)} USDC` : ""}`);

    return { executed: true, receipt, netChange, gas: actualGasInfo };
  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${(err.error && err.error.message) || err.reason || err.message || err}`);
    return { executed: false, reason: err.message || err };
  }
}

// ---------------- scan loop ----------------
async function scanOnce() {
  console.log("🔍 Starting arbitrage scan...");
  const usdcAmount = TRADE_AMOUNT_USDC;

  for (const [sym, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        if (!buyRouter || !sellRouter) continue;

        try {
          // get amounts out
          const buyOut = await getAmountOut(buyRouter, token, usdcAmount);
          const sellOut = await getAmountOut(sellRouter, token, usdcAmount);

          // compute buy and sell price (USDC per token)
          // buyOut = token amount for TRADE_AMOUNT_USDC; price = USDC/token = TRADE_AMOUNT_USDC / tokenAmount
          const buyPrice = usdcAmount / buyOut;
          const sellPrice = usdcAmount / sellOut;

          // profit in USDC (gross)
          let profitUSDC = sellPrice - buyPrice;
          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          const profitPct = (profitUSDC / buyPrice) * 100;

          if (profitPct >= MIN_PROFIT_PCT) {
            // Log opportunity
            console.log("");
            console.log(`🚨 ${sym} | Buy:${buyName} @ $${fmt(buyPrice,6)} → Sell:${sellName} @ $${fmt(sellPrice,6)} | Estimated profit: ${fmt(profitUSDC,6)} USDC (${fmt(profitPct,2)}%)`);
            console.log(`🔹 Opportunity: Buy on ${buyRouter} / Sell on ${sellRouter}`);
            console.log(`🔸 Token: ${token.address}`);
            console.log(`🔸 Buy price: $${fmt(buyPrice,6)} | Sell price: $${fmt(sellPrice,6)}`);
            console.log(`🔸 Estimated gross profit: ${fmt(profitUSDC,6)} USDC`);

            // Quick gas estimate (populate + estimate)
            const populated = await arbContract.populateTransaction.executeArbitrage(
              buyRouter, sellRouter, token.address, ethers.parseUnits(usdcAmount.toString(), 6)
            );

            // try to estimate gas; if fails continue
            let gasEstimate;
            try {
              gasEstimate = await wallet.estimateGas({ to: CONTRACT_ADDRESS, data: populated.data });
            } catch (err) {
              console.warn("⚠️ estimateGas failed for opportunity:", err.message || err);
              continue;
            }

            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
            const estGasInfo = await gasCostToUSDC(gasEstimate, gasPrice);
            console.log(`💸 Estimated gas: ${fmt(estGasInfo.matic,6)} MATIC ${estGasInfo.usdc ? `≈ ${fmt(estGasInfo.usdc,6)} USDC` : ""} (gasPrice: ${ethers.formatUnits(gasPrice,9)} gwei, gasEstimate: ${gasEstimate.toString()})`);

            const netAfterGas = profitUSDC - (estGasInfo.usdc ?? 0);
            console.log(`🧮 Net profit after gas: ${fmt(netAfterGas,6)} USDC`);

            // Check contract USDC balance before and wallet MATIC balance
            const usdcContract = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
            const contractUSDCBefore = Number(ethers.formatUnits(await usdcContract.balanceOf(CONTRACT_ADDRESS), 6));
            const walletMaticBalance = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
            console.log(`🏦 Contract USDC balance (before): ${fmt(contractUSDCBefore,6)} USDC`);
            console.log(`⏳ Wallet MATIC balance: ${fmt(walletMaticBalance,6)} MATIC`);

            // only execute if netAfterGas positive and wallet has enough MATIC for gas
            const requiredMatic = estGasInfo.matic;
            if ((estGasInfo.usdc !== null && netAfterGas <= 0) || walletMaticBalance < Math.max(0.001, requiredMatic * 1.1)) {
              console.log("⚠️ Skipping execution: insufficient net profit after gas or not enough MATIC in wallet for gas.");
              continue;
            }

            // Execute: sim + send + wait
            const res = await executeTrade(buyRouter, sellRouter, token.address, usdcAmount);
            if (res.executed) {
              console.log("🔍 Scan pass: trade executed.");
            } else {
              console.log("🔍 Scan pass: trade NOT executed. reason:", res.reason || "unknown");
            }
            console.log(""); // spacing
          }
        } catch (e) {
          console.warn(`⚠️ Error scanning ${sym} ${buyName}->${sellName}: ${e.message || e}`);
          // continue scanning others
        }
      }
    }
  }

  console.log("🔍 Scan complete.");
}

// ---------------- main loop ----------------
async function main() {
  // sanity
  try {
    const owner = await arbContract.owner();
    console.log("✅ Connected to contract:", CONTRACT_ADDRESS);
    console.log("👤 Contract owner:", owner);
  } catch (e) {
    console.warn("⚠️ Connected contract may not expose owner(); continuing anyway. Error:", e.message || e);
  }

  while (true) {
    await scanOnce();
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

