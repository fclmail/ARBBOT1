// arbjs-safesim-exec.mjs
// Scans, SafeSim dry-run (Flashbots public safesim), then calls executeArbitrage(...) on-chain if sim passes.
// Node 18+ required (native fetch). Uses ethers v6.

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const LIVE_RUN = (process.env.LIVE_RUN === "true"); // default false
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 1000); // USDC units (not wei)
const MIN_NET_PROFIT_USDC = Number(process.env.MIN_NET_PROFIT_USDC || 1);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);
const CHAIN_ID = Number(process.env.CHAIN_ID || 137); // polygon

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error("❌ Missing env: PRIVATE_KEY and CONTRACT_ADDRESS are required.");
  process.exit(1);
}

// -------------------- PROVIDER & WALLET --------------------
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// -------------------- CONTRACT ABI --------------------
const arbAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { inputs: [], name: "USDC", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// -------------------- ROUTERS & TOKENS --------------------
// Use checksummed addresses (ethers.getAddress will normalize)
const routersRaw = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
  // add additional routers if desired
};

const routers = {};
for (const [k, v] of Object.entries(routersRaw)) {
  try { routers[k] = ethers.getAddress(v); } catch (e) { console.warn(`Router ${k} address invalid: ${v}`); }
}

const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 }
  // add tokens as needed
};

// -------------------- HELPERS --------------------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountInUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  // read USDC from contract if available; else use canonical Polygon USDC (example)
  let usdcAddress;
  try { usdcAddress = await arbContract.USDC(); } catch { usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; }

  const path = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch (err) {
    // fallback via WBTC if direct pair doesn't exist
    try {
      const path2 = [usdcAddress, "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", token.address]; // WBTC address here
      const amounts2 = await router.getAmountsOut(ethers.parseUnits(amountInUSDC.toString(), 6), path2);
      return Number(ethers.formatUnits(amounts2[amounts2.length - 1], token.decimals));
    } catch (err2) {
      throw new Error(`getAmountOut failed on ${routerAddr}: ${err2?.message || err2}`);
    }
  }
}

// -------------------- SafeSim (Flashbots public) --------------------
/*
  Mode A: single contract call simulation via eth_callBundle endpoint.
  We build a full signed transaction (EIP-1559), then POST {"jsonrpc":"2.0","id":1,"method":"eth_callBundle","params":[{txs:[signed], blockNumber:"latest", stateBlockNumber:"latest"}]}
*/
async function simulateSafeSim(txRequestPartial) {
  try {
    const chain = await provider.getNetwork();
    const chainId = chain.chainId;
    const from = await wallet.getAddress();

    // Build minimal tx for gas estimate
    const txForEstimate = {
      to: txRequestPartial.to,
      data: txRequestPartial.data,
      value: txRequestPartial.value ?? 0,
      from
    };

    // estimate gas (best-effort)
    let gasLimit;
    try {
      gasLimit = await provider.estimateGas(txForEstimate);
      if (gasLimit > 3_000_000n) gasLimit = 3_000_000n;
    } catch {
      gasLimit = 1_200_000n; // fallback
    }

    const feeData = await provider.getFeeData();
    const maxPriorityFeePerGas = BigInt(feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 0n);
    const maxFeePerGas = BigInt(feeData.maxFeePerGas ?? ((feeData.gasPrice ?? 0n) * 2n));
    const nonce = await provider.getTransactionCount(from);

    const txFull = {
      to: txForEstimate.to,
      data: txForEstimate.data,
      value: BigInt(txForEstimate.value ?? 0),
      chainId,
      nonce,
      gasLimit: BigInt(gasLimit),
      maxPriorityFeePerGas,
      maxFeePerGas,
      type: 2
    };

    const signed = await wallet.signTransaction(txFull);

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
      body: JSON.stringify(body)
    });

    const json = await res.json();
    return { ok: true, raw: json, signed, txFull };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// -------------------- Execute on-chain trade (calls your contract) --------------------
let cumulativeProfit = 0;

async function executeTradeOnChain(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  if (!LIVE_RUN) {
    console.log("🔬 LIVE_RUN=false — skipping on-chain execution.");
    return null;
  }

  try {
    // read USDC address & balance before
    let usdcAddr = await arbContract.USDC().catch(() => null);
    let balanceBefore = null;
    if (usdcAddr) {
      const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
      balanceBefore = Number(ethers.formatUnits(await usdc.balanceOf(CONTRACT_ADDRESS), 6));
    }

    console.log("🔐 Sending executeArbitrage on-chain...");
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amountUSDC.toString(), 6),
      { gasLimit: 3_000_000 }
    );

    console.log(`⏳ TX sent: ${tx.hash} — awaiting confirmation...`);
    const receipt = await tx.wait();
    console.log(`✅ TX mined: ${tx.hash} | block ${receipt.blockNumber}`);
    console.log(`⛽ gasUsed: ${receipt.gasUsed.toString()} | effectiveGasPrice: ${receipt.effectiveGasPrice?.toString() ?? "n/a"}`);

    // read balance after
    if (balanceBefore !== null && usdcAddr) {
      const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
      const balanceAfter = Number(ethers.formatUnits(await usdc.balanceOf(CONTRACT_ADDRESS), 6));
      const net = balanceAfter - balanceBefore;
      cumulativeProfit += net;
      console.log(`💹 Net USDC this tx: ${fmt(net,6)} | cumulative: ${fmt(cumulativeProfit,6)}`);
      return { receipt, net };
    }

    return { receipt };
  } catch (err) {
    console.error("⚠️ executeTradeOnChain failed:", err?.reason || err?.message || String(err));
    return null;
  }
}

// -------------------- SCAN LOOP --------------------
async function scanOnce() {
  console.log(new Date().toISOString(), "🔍 scanning for arbitrage...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    const routerEntries = Object.entries(routers);
    for (let i = 0; i < routerEntries.length; i++) {
      for (let j = 0; j < routerEntries.length; j++) {
        if (i === j) continue;
        const [buyName, buyRouter] = routerEntries[i];
        const [sellName, sellRouter] = routerEntries[j];

        // fetch amounts
        let buyOut, sellOut;
        try {
          buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
        } catch (err) {
          // router pair not available or call failed
          // console.debug(`skip pair ${buyName}->${sellName}: ${err.message}`);
          continue;
        }

        const buyPrice = TRADE_AMOUNT_USDC / buyOut;
        const sellPrice = TRADE_AMOUNT_USDC / sellOut;
        let profitUSDC = sellPrice - buyPrice;
        let profitPct = (profitUSDC / buyPrice) * 100;

        // slippage adjust as needed (here 0)
        profitUSDC *= (1 - 0 / 100);
        profitPct *= (1 - 0 / 100);

        // gate by thresholds
        if (profitUSDC >= MIN_NET_PROFIT_USDC && profitPct >= Number(process.env.MIN_PROFIT_PCT || 0)) {
          console.log(`🚨 ${symbol} | Buy:${buyName} @ ${fmt(buyPrice)} → Sell:${sellName} @ ${fmt(sellPrice)} | Profit: ${fmt(profitUSDC,6)} USDC (${fmt(profitPct,2)}%)`);

          // Build txRequest for executeArbitrage (populateTransaction)
          let txRequest;
          try {
            txRequest = await arbContract.populateTransaction.executeArbitrage(
              buyRouter, sellRouter, token.address, ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
            );
          } catch (err) {
            console.warn("⚠️ populateTransaction failed:", err?.message || String(err));
            continue;
          }

          console.log("🔎 Running SafeSim (public) for the exact contract call — no gas spent...");
          const sim = await simulateSafeSim(txRequest);

          if (!sim.ok) {
            console.warn("❌ SafeSim request failed:", sim.error);
            continue;
          }

          // print full SafeSim raw result for visibility
          try {
            console.log("🟦 SafeSim raw result:");
            console.log(JSON.stringify(sim.raw, null, 2));
          } catch {
            console.log(sim.raw);
          }

          // Evaluate SafeSim output
          if (sim.raw?.error) {
            console.warn("❌ SafeSim returned error:", sim.raw.error);
            continue;
          }

          if (sim.raw?.result?.firstRevert) {
            console.warn("❌ SafeSim indicates revert. Skipping this opportunity.");
            continue;
          }

          // Optionally check coinbaseDiff or transaction_info token changes
          if (sim.raw?.result?.coinbaseDiff) {
            try {
              const coinbaseDiff = BigInt(sim.raw.result.coinbaseDiff);
              const coinbaseNative = Number(ethers.formatUnits(coinbaseDiff, 18));
              console.log(`🔎 SafeSim coinbaseDiff (native): ${coinbaseNative}`);
            } catch {}
          }

          // If SafeSim passed, proceed to live execution (if allowed)
          console.log("✅ SafeSim passed for this contract call.");
          if (LIVE_RUN) {
            console.log("🚀 LIVE_RUN=true → executing on-chain (executeArbitrage)...");
            await executeTradeOnChain(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          } else {
            console.log("🔬 DRY RUN (LIVE_RUN=false) — not executing on-chain.");
          }

          opportunities.push({ symbol, buyName, sellName, profitUSDC, profitPct });
        }
      }
    }
  } // end loops

  console.log(`🔍 Scan complete. Opportunities found: ${opportunities.length}`);
  return opportunities;
}

// -------------------- MAIN --------------------
async function main() {
  console.log("🚀 ArbJS SafeSim -> executeArbitrage runner");
  console.log("Wallet:", await wallet.getAddress());
  console.log("Contract:", CONTRACT_ADDRESS);
  console.log("LIVE_RUN:", LIVE_RUN);
  console.log("Scan interval (ms):", SCAN_INTERVAL_MS);

  while (true) {
    try {
      await scanOnce();
    } catch (err) {
      console.error("❌ scanOnce error:", err?.message || String(err));
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(e => {
  console.error("Fatal error:", e?.message || String(e));
  process.exit(1);
});
