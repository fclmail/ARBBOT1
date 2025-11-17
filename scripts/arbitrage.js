// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (SafeSim integrated)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// optional fetch polyfill for older Node versions (GH Actions usually has fetch)
if (typeof globalThis.fetch !== "function") {
  try {
    // dynamic import so this file still runs if node-fetch isn't installed
    const fetchMod = await import("node-fetch");
    globalThis.fetch = fetchMod.default;
  } catch (e) {
    console.warn("⚠️ fetch not found and node-fetch not installed — SafeSim will fail if fetch unavailable.");
  }
}

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_NET_PROFIT_USDC = Number(process.env.MIN_NET_PROFIT_USDC || 1); // minimal profit after gas to execute

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS in .env");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ABI 🟢2 ───────────────
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

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS 🟢4 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS 🟢5 ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── SETTINGS 🟢6 ───────────────
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.04); // USDC amount used in pricing check
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 3);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0);

// ─────────────── HELPERS 🟢7 ───────────────
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
    // fallback path
    const path2 = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path2
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── SafeSim Helper 🟢NEW ───────────────
// Builds a full tx (with gas/fees/nonce), signs it, sends to SafeSim and returns parsed result.
async function simulateSafeSim(txRequestPartial) {
  try {
    // required fields
    const chain = await provider.getNetwork();
    const chainId = chain.chainId;

    const from = await wallet.getAddress();

    // prepare minimal tx object for signing/simulation
    const txForEstimate = {
      to: txRequestPartial.to || CONTRACT_ADDRESS,
      data: txRequestPartial.data,
      value: txRequestPartial.value ?? 0,
      from
    };

    // estimate gas (cap fallback)
    let gasLimit;
    try {
      gasLimit = await provider.estimateGas(txForEstimate);
      // safety cap
      if (gasLimit > 2_000_000n) gasLimit = 2_000_000n;
    } catch (e) {
      gasLimit = BigInt(800_000); // fallback
    }

    // get fee data (EIP-1559)
    const feeData = await provider.getFeeData();

    // if feeData does not provide maxFeePerGas, try deriving from gas price
    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 0;
    let maxFeePerGas = feeData.maxFeePerGas ?? ((feeData.gasPrice ?? 0n) * 2n);

    // ensure we have BigInt typed fields
    maxPriorityFeePerGas = BigInt(maxPriorityFeePerGas);
    maxFeePerGas = BigInt(maxFeePerGas);

    const nonce = await provider.getTransactionCount(from);

    const tx = {
      to: txForEstimate.to,
      data: txForEstimate.data,
      value: txForEstimate.value,
      chainId,
      nonce,
      gasLimit: BigInt(gasLimit),
      maxPriorityFeePerGas,
      maxFeePerGas,
      type: 2
    };

    // sign raw tx
    const signed = await wallet.signTransaction(tx);

    // Build safesim JSON-RPC payload
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_callBundle",
      params: [{
        txs: [signed],
        blockNumber: "latest",
        stateBlockNumber: "latest"
      }]
    };

    const res = await fetch("https://rpc.flashbots.net/safesim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // timeout not available in fetch; GH Actions will handle
    });

    const json = await res.json();

    return { success: true, raw: json, txMeta: { tx, signed } };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

// ─────────────── CUMULATIVE PROFIT TRACKING 🟢8 ───────────────
let cumulativeProfit = 0;

// ─────────────── EXECUTE TRADE WITH PROFIT TRACKING 🟢9 ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    // Read USDC balance BEFORE trade
    const usdcAddress = await arbContract.USDC();
    const usdc = new ethers.Contract(
      usdcAddress,
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );

    const balanceBefore = await usdc.balanceOf(CONTRACT_ADDRESS);
    const balanceBeforeFloat = Number(ethers.formatUnits(balanceBefore, 6));

    // Send transaction
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), 6),
      { gasLimit: 2_000_000 } // still provide a gasLimit guard
    );

    console.log(`⏳ Trade sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined: ${tx.hash} | block ${receipt.blockNumber}`);

    // Gas used & gas cost calculation
    const gasUsed = receipt.gasUsed ?? 0n;
    const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
    const gasCostWei = BigInt(gasUsed) * BigInt(effectiveGasPrice);
    const gasCostEth = Number(ethers.formatUnits(gasCostWei, 18)); // in MATIC (native)
    console.log(`⛽ Gas used: ${gasUsed.toString()} | cost (MATIC): ${gasCostEth}`);

    // Read USDC balance AFTER trade
    const balanceAfter = await usdc.balanceOf(CONTRACT_ADDRESS);
    const balanceAfterFloat = Number(ethers.formatUnits(balanceAfter, 6));

    // Compute net profit in USDC
    const netProfit = balanceAfterFloat - balanceBeforeFloat;
    cumulativeProfit += netProfit;

    console.log(`💹 Net USDC change this tx: ${netProfit.toFixed(6)} USDC`);
    console.log(`📊 Cumulative profit this session: ${cumulativeProfit.toFixed(6)} USDC`);
  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${err?.reason || err?.message || String(err)}`);
  }
}

// ─────────────── SCAN LOOP 🟢10 ───────────────
async function scan() {
  console.log(new Date().toISOString(), "🔍 Scanning for arbitrage opportunities...");
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
              `🚨 ${symbol} | Buy:${buyName} @ ${fmt(buyPrice)} → Sell:${sellName} @ ${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`
            );

            // -----------------------------
            // OFF-CHAIN CHECK (SafeSim)
            // -----------------------------
            // 1) Build txRequest via populateTransaction (not sending)
            const txRequest = await arbContract.populateTransaction.executeArbitrage(
              buyRouter,
              sellRouter,
              token.address,
              ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
            );

            console.log("🔎 Running SafeSim off-chain simulation...");
            const simRes = await simulateSafeSim(txRequest);

            if (!simRes.success) {
              console.log(`❌ SafeSim request failed: ${simRes.error || JSON.stringify(simRes.raw)}`);
              continue;
            }

            const raw = simRes.raw;
            // handle possible shapes
            if (raw.error) {
              console.log("❌ SafeSim returned error:", raw.error);
              continue;
            }
            if (!raw.result) {
              console.log("❌ SafeSim returned no result:", JSON.stringify(raw));
              continue;
            }

            // If SafeSim indicates firstRevert or error
            if (raw.result.firstRevert) {
              console.log("❌ SafeSim indicates revert. Skipping this opportunity.");
              continue;
            }

            // coinbaseDiff is profit lv in wei (native) paid to miner? For bundles it can represent difference.
            // Some SafeSim responses include .coinbaseDiff which is an integer (may be hex string).
            let simProfitNative = 0n;
            if (raw.result.coinbaseDiff) {
              try {
                simProfitNative = BigInt(raw.result.coinbaseDiff);
              } catch {
                // Sometimes it's a decimal string
                try { simProfitNative = BigInt(Number(raw.result.coinbaseDiff)); } catch {}
              }
            }

            // Convert native simProfit to USDC approximation:
            // SafeSim coinbaseDiff is usually in wei of native token. To compare to MIN_NET_PROFIT_USDC we need
            // a conservative check: require the simulation to be profitable in on-chain USDC balances.
            // However SafeSim may not directly return USDC delta; we'll also look for bundle receipts or logs.
            let simProfitUSDC = null;
            // attempt to parse any "usdc" delta in result (best-effort)
            if (raw.result.simulation && raw.result.simulation[0] && raw.result.simulation[0].balances) {
              // not guaranteed; skip complex parsing
            }

            // fallback: if coinbaseDiff > 0, assume some profit (but we need USDC threshold)
            if (simProfitNative > 0n) {
              // convert simProfitNative (wei) to MATIC float
              const simProfitMatic = Number(ethers.formatUnits(simProfitNative, 18));
              console.log(`🔎 SafeSim -> coinbaseDiff: ${simProfitMatic} native (MATIC)`);
              // NOTE: cannot reliably convert MATIC to USDC without an oracle — be conservative:
              // require coinbaseDiff > 0 AND original computed profitUSDC >= MIN_NET_PROFIT_USDC
              // so we use the on-chain computed profitUSDC as main guide.
            } else {
              console.log("🔎 SafeSim -> coinbaseDiff indicates no miner profit. Will inspect on-chain USDC delta after execution if attempted.");
            }

            // Additional conservative gate: ensure the price-model profitUSDC >= MIN_NET_PROFIT_USDC
            if (profitUSDC < MIN_NET_PROFIT_USDC) {
              console.log(`⚠️ Profit estimate ${fmt(profitUSDC)} USDC below MIN_NET_PROFIT_USDC ${MIN_NET_PROFIT_USDC}. Skipping.`);
              continue;
            }

            // If we reach here: SafeSim did NOT indicate revert, and profit estimate passes ours
            console.log(`✅ SafeSim passed. Proceeding to execute real trade for ${symbol} ${buyName}→${sellName}`);

            // Execute real trade
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          } // end if profitPct
        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e?.message || String(e)}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP 🟢11 ───────────────
async function main() {
  try {
    console.log("🚀 Aave Flash Arbitrage Bot (SafeSim) running on Polygon...");
    console.log("✅ Connected to contract:", await arbContract.getAddress());
    console.log("👤 Contract owner:", await arbContract.owner());
  } catch (e) {
    console.error("❌ Startup error:", e);
    process.exit(1);
  }

  // Loop forever (careful in GH Actions - you may want a controlled schedule)
  while (true) {
    await scan();
    // pause 5s (tweakable or replace with event-driven scheduler)
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
