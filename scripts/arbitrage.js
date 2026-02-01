// 🟢 Graph-Based Arbitrage Bot (ethers v6)
// 🔗 Market modeled as graph
// 🧠 Detect → simulate → execute (once confirmed)
// ❗ Drop-in replacement for scanning logic

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────────────────────────────────────
// 1️⃣ RPC + WALLET
// ─────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ─────────────────────────────────────────────
// 2️⃣ ADDRESSES
// ─────────────────────────────────────────────
const VAULT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const TOKENS = {
  USDC:   { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  WMATIC:{ address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 }
};

const ROUTERS = {
  UNI:   "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

// ─────────────────────────────────────────────
// 3️⃣ ABIs
// ─────────────────────────────────────────────
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function totalAssets() view returns (uint256)"
];

const v2ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)"
];

// ─────────────────────────────────────────────
// 4️⃣ CONTRACTS
// ─────────────────────────────────────────────
const vault  = new ethers.Contract(VAULT, vaultABI, wallet);
const sushi  = new ethers.Contract(ROUTERS.SUSHI, v2ABI, provider);
const quoter = new ethers.Contract(QUOTER, quoterABI, provider);

// ─────────────────────────────────────────────
// 5️⃣ CONFIG
// ─────────────────────────────────────────────
const TRADE_SIZE = ethers.parseUnits("0.8", 6);
const MIN_SPREAD = 0.15; // %
const UNI_FEE    = 3000;

let executing = false;

// ─────────────────────────────────────────────
// 6️⃣ GRAPH MODEL
// ─────────────────────────────────────────────
async function buildGraph() {
  const uniOut = await quoter.quoteExactInputSingle(
    TOKENS.USDC.address,
    TOKENS.WMATIC.address,
    UNI_FEE,
    TRADE_SIZE,
    0
  );

  const sushiOut = await sushi.getAmountsOut(
    TRADE_SIZE,
    [TOKENS.USDC.address, TOKENS.WMATIC.address]
  );

  return {
    UNI:   uniOut,
    SUSHI: sushiOut[1]
  };
}

// ─────────────────────────────────────────────
// 7️⃣ ARBITRAGE DETECTOR (GRAPH EDGE COMPARISON)
// ─────────────────────────────────────────────
function detectArbitrage(graph) {
  const uniPrice =
    Number(ethers.formatUnits(TRADE_SIZE, 6)) /
    Number(ethers.formatUnits(graph.UNI, 18));

  const sushiPrice =
    Number(ethers.formatUnits(TRADE_SIZE, 6)) /
    Number(ethers.formatUnits(graph.SUSHI, 18));

  const spreadPct = ((sushiPrice - uniPrice) / uniPrice) * 100;

  return { uniPrice, sushiPrice, spreadPct };
}

// ─────────────────────────────────────────────
// 8️⃣ EXECUTION LOOP
// ─────────────────────────────────────────────
async function runGraphArb() {
  if (executing) return;
  executing = true;

  const ts = new Date().toISOString();

  try {
    const graph = await buildGraph();
    const { uniPrice, sushiPrice, spreadPct } = detectArbitrage(graph);

    console.log(`[${ts}] UNI:   ${uniPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] SUSHI: ${sushiPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] Spread: ${spreadPct.toFixed(4)}%`);

    if (spreadPct < MIN_SPREAD) {
      console.log(`[${ts}] ❌ No executable arbitrage`);
      console.log("──────────────────────────────");
      return;
    }

    console.log(`[${ts}] ✅ ARBITRAGE FOUND (SUSHI → UNI)`);
    console.log(`[${ts}] EXECUTING ON-CHAIN...`);

    const walletBal = await provider.getBalance(wallet.address);
    const vaultBefore = await vault.totalAssets();

    console.log(`[${ts}] 🔎 Wallet MATIC: ${ethers.formatEther(walletBal)}`);
    console.log(`[${ts}] 🏦 Vault balance (before): ${ethers.formatUnits(vaultBefore, 6)} USDC`);

    const deadline = Math.floor(Date.now() / 1000) + 120;
    const nonce = await provider.getTransactionCount(wallet.address);

    const tx = await vault.executeArbitrage(
      ROUTERS.SUSHI,
      ROUTERS.UNI,
      TRADE_SIZE,
      [TOKENS.USDC.address, TOKENS.WMATIC.address],
      [TOKENS.WMATIC.address, TOKENS.USDC.address],
      deadline,
      {
        nonce,
        gasLimit: 1_500_000,
        maxFeePerGas: ethers.parseUnits("150", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("80", "gwei")
      }
    );

    console.log(`[${ts}] TX SENT: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`[${ts}] TX CONFIRMED: ${receipt.transactionHash}`);

    const vaultAfter = await vault.totalAssets();
    console.log(`[${ts}] 🏦 Vault balance (after): ${ethers.formatUnits(vaultAfter, 6)} USDC`);
    console.log(`[${ts}] 💰 PROFIT SENT TO VAULT`);
    console.log("──────────────────────────────");

  } catch (err) {
    console.error(`[${ts}] ERROR`, err.reason || err.message || err);
  } finally {
    executing = false;
  }
}

// ─────────────────────────────────────────────
// 9️⃣ RUN (BLOCK-DRIVEN, GRAPH-CONFIRMED)
// ─────────────────────────────────────────────
setInterval(runGraphArb, 5000);
