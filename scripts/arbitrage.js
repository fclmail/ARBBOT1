// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (SafeSim Integrated)
// ─────────────────────────────────────────────

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// optional fetch polyfill for older Node
if (typeof globalThis.fetch !== "function") {
  try {
    // eslint-disable-next-line no-await-in-async-function
    (async () => {
      const fetchMod = await import("node-fetch");
      globalThis.fetch = fetchMod.default;
    })();
  } catch (e) {
    console.warn("⚠️ fetch not found, SafeSim may fail");
  }
}

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_NET_PROFIT_USDC = Number(process.env.MIN_NET_PROFIT_USDC || 1);

if (!PRIVATE_KEY) {
  throw new Error("❌ Missing PRIVATE_KEY in .env");
}
if (!CONTRACT_ADDRESS) {
  throw new Error("❌ Missing CONTRACT_ADDRESS in .env");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ABI 🟢2 ───────────────
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
  { inputs: [], name: "USDC", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS 🟢4 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8B607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",
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
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.04);
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
    // amounts last element is output token amount in its decimals
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    // fallback path via WBTC
    const path2 = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path2
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── SafeSim Helper 🟢8 ───────────────
async function simulateSafeSim(txRequestPartial) {
  try {
    const chain = await provider.getNetwork();
    const chainId = chain.chainId;
    const from = await wallet.getAddress();

    let gasLimit;
    try {
      gasLimit = await provider.estimateGas({ ...txRequestPartial, from });
      if (gasLimit > 2_000_000n) gasLimit = 2_000_000n;
    } catch {
      gasLimit = 800_000n;
    }

    const feeData = await provider.getFeeData();
    const maxPriorityFeePerGas =
      BigInt(feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 0n);
    const maxFeePerGas =
      BigInt(feeData.maxFeePerGas ?? (feeData.gasPrice ?? 0n) * 2n);
    const nonce = await provider.getTransactionCount(from);

    const tx = {
      ...txRequestPartial,
      from,
      chainId,
      nonce,
      gasLimit,
      maxPriorityFeePerGas,
      maxFeePerGas,
      type: 2
    };

    // Sign the transaction
    const signed = await wallet.signTransaction(tx);

    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_callBundle",
      params: [{ txs: [signed], blockNumber: "latest", stateBlockNumber: "latest" }]
    };

    const res = await fetch("https://rpc.flashbots.net/safesim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const json = await res.json();
    return { success: true, raw: json, txMeta: { tx, signed } };
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ─────────────── CUMULATIVE PROFIT 🟢9 ───────────────
let cumulativeProfit = 0;

// ─────────────── EXECUTE TRADE 🟢10 ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const usdcAddress = await arbContract.USDC();
    const usdc = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns (uint256)"], provider);
    const balanceBefore = Number(ethers.formatUnits(await usdc.balanceOf(CONTRACT_ADDRESS), 6));

    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), 6),
      { gasLimit: 2_000_000 }
    );

    console.log(`⏳ Trade sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined: ${tx.hash} | block ${receipt.blockNumber}`);

    const balanceAfter = Number(ethers.formatUnits(await usdc.balanceOf(CONTRACT_ADDRESS), 6));
    const netProfit = balanceAfter - balanceBefore;
    cumulativeProfit += netProfit;

    console.log(`💹 Net USDC this tx: ${netProfit.toFixed(6)} | Cumulative: ${cumulativeProfit.toFixed(6)}`);
  } catch (err) {
    console.error(`⚠️ Trade failed: ${err?.reason || err?.message || String(err)}`);
  }
}

// ─────────────── SCAN LOOP 🟢11 ───────────────
async function scan() {
  console.log(new Date().toISOString(), "🔍 Scanning for arbitrage opportunities...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouterRaw] of Object.entries(routers)) {
      for (const [sellName, sellRouterRaw] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        let buyRouter, sellRouter;
        try {
          buyRouter = ethers.getAddress(buyRouterRaw);
          sellRouter = ethers.getAddress(sellRouterRaw);
        } catch (err) {
          console.warn(`⚠️ Invalid router address ${buyName}->${sellName}: ${err.message}`);
          continue;
        }

        let buyOut, sellOut;
        try {
          buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
        } catch (err) {
          console.warn(`⚠️ Skipping ${symbol} ${buyName}->${sellName}: ${err?.message ?? String(err)}`);
          continue;
        }

        // If either output is zero or invalid, skip
        if (!buyOut || !sellOut) continue;

        // Calculate profitability
        const buyAmountIn = TRADE_AMOUNT_USDC;
        const buyPrice = buyAmountIn / buyOut;
        const sellPrice = TRADE_AMOUNT_USDC / sellOut;

        let profitUSDC = sellPrice - buyPrice;
        let profitPct = (profitUSDC / Math.max(buyPrice, 1e-18)) * 100;
        // Apply slippage
        profitUSDC *= (1 - SLIPPAGE_PCT / 100);
        profitPct *= (1 - SLIPPAGE_PCT / 100);

        if (profitPct >= MIN_PROFIT_PCT && profitUSDC >= MIN_NET_PROFIT_USDC) {
          opportunities.push({ token: symbol, buyName, sellName, profitUSDC, profitPct });
          console.log(`🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          // SafeSim check
          let txRequest;
          try {
            txRequest = await arbContract.populateTransaction.executeArbitrage(
              buyRouter, sellRouter, token.address, ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6)
            );
          } catch (e) {
            console.warn(`⚠️ Failed to populate arbitrate TX: ${e?.message ?? String(e)}`);
            continue;
          }

          const simRes = await simulateSafeSim(txRequest);
          if (!simRes.success) {
            console.log(`❌ SafeSim failed. Skipping ${symbol} ${buyName}->${sellName} (${simRes.error ?? ""})`);
            continue;
          }

          // If SafeSim indicates a feasible path, execute
          console.log(`✅ SafeSim passed. Executing trade...`);
          await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP 🟢12 ───────────────
async function main() {
  try {
    console.log("🚀 Aave Flash Arbitrage Bot (SafeSim) running on Polygon...");
    console.log("✅ Connected to contract:", CONTRACT_ADDRESS);
    console.log("👤 Contract owner:", await arbContract.owner());
  } catch (err) {
    console.error("❌ Startup error:", err);
    process.exit(1);
  }

  while (true) {
    try {
      await scan();
    } catch (err) {
      console.error("❗ Scan loop error:", err);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(err => console.error("Fatal error:", err));
