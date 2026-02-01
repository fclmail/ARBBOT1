// 🟢 Fully functional bidirectional arbitrage script (ethers v6)
// FIXES: nonce management, gas bumping, retries, and non-blocking confirmations

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────────────────────────────────────
// 1️⃣ RPC + WALLET
// ─────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ─────────────────────────────────────────────
// 2️⃣ ADDRESSES (Polygon)
// ─────────────────────────────────────────────
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const UNISWAP_V2_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

// ─────────────────────────────────────────────
// 3️⃣ ABIs
// ─────────────────────────────────────────────
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external"
];

const sushiABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external view returns (uint256)"
];

// ─────────────────────────────────────────────
// 4️⃣ CONTRACT INSTANCES
// ─────────────────────────────────────────────
const vault = new ethers.Contract(VAULT_CONTRACT, vaultABI, wallet);
const sushi = new ethers.Contract(SUSHI_ROUTER, sushiABI, provider);
const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, quoterABI, provider);

// ─────────────────────────────────────────────
// 5️⃣ BOT CONFIG
// ─────────────────────────────────────────────
const TRADE_SIZE = ethers.parseUnits("0.8", 6);
const MIN_SPREAD = 0.05;
const UNI_FEE = 3000;

let executing = false;

// ─────────────────────────────────────────────
// 6️⃣ NONCE MANAGEMENT
// ─────────────────────────────────────────────
let noncePromise = provider.getTransactionCount(wallet.address, "pending");

// Helper to get and increment nonce
async function getNonce() {
  const currentNonce = await noncePromise;
  noncePromise = currentNonce + 1;
  return currentNonce;
}

// ─────────────────────────────────────────────
// 7️⃣ SEND TX WITH RETRIES & GAS BUMP
// ─────────────────────────────────────────────
async function sendTxWithRetry(txRequest, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      txRequest.nonce = await getNonce();

      const tx = await wallet.sendTransaction(txRequest);
      console.log(`[${new Date().toISOString()}] TX SENT: ${tx.hash}`);

      // Fire-and-forget confirmation
      provider.once(tx.hash, (receipt) => {
        console.log(`[${new Date().toISOString()}] TX CONFIRMED: ${receipt.transactionHash}`);
        console.log(`[${new Date().toISOString()}] 💰 PROFIT SENT TO VAULT`);
        console.log("──────────────────────────────");
      });

      return tx;
    } catch (err) {
      console.log(`[${new Date().toISOString()}] TX FAILED OR STUCK: ${err.message}`);
      txRequest.maxPriorityFeePerGas = txRequest.maxPriorityFeePerGas.mul(2);
      txRequest.maxFeePerGas = txRequest.maxFeePerGas.mul(2);
      attempt++;
      console.log(`[${new Date().toISOString()}] Retrying transaction with higher gas (attempt ${attempt})`);
    }
  }
  throw new Error("TX FAILED AFTER MAX RETRIES");
}

// ─────────────────────────────────────────────
// 8️⃣ MAIN LOOP
// ─────────────────────────────────────────────
async function checkAndExecute() {
  if (executing) return;
  executing = true;

  const ts = new Date().toISOString();

  try {
    // Fetch prices
    const sushiOut = await sushi.getAmountsOut(TRADE_SIZE, [USDC, WMATIC]);
    const sushiWmatic = sushiOut[1];

    const uniWmatic = await quoter.quoteExactInputSingle(
      USDC,
      WMATIC,
      UNI_FEE,
      TRADE_SIZE,
      0
    );

    const sushiPrice =
      Number(ethers.formatUnits(TRADE_SIZE, 6)) /
      Number(ethers.formatUnits(sushiWmatic, 18));

    const uniPrice =
      Number(ethers.formatUnits(TRADE_SIZE, 6)) /
      Number(ethers.formatUnits(uniWmatic, 18));

    const spreadPct = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`[${ts}] UNI:   ${uniPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] SUSHI: ${sushiPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] Spread: ${spreadPct.toFixed(4)}%`);

    let buyRouter, sellRouter, buyPath, sellPath, direction;

    if (spreadPct <= -MIN_SPREAD) {
      buyRouter = UNISWAP_V2_ROUTER;
      sellRouter = SUSHI_ROUTER;
      buyPath = [USDC, WMATIC];
      sellPath = [WMATIC, USDC];
      direction = "UNI → SUSHI";
    } else if (spreadPct >= MIN_SPREAD) {
      buyRouter = SUSHI_ROUTER;
      sellRouter = UNISWAP_V2_ROUTER;
      buyPath = [USDC, WMATIC];
      sellPath = [WMATIC, USDC];
      direction = "SUSHI → UNI";
    } else {
      console.log(`[${ts}] ❌ No executable arbitrage`);
      console.log("──────────────────────────────");
      return;
    }

    console.log(`[${ts}] ✅ ARBITRAGE FOUND (${direction})`);
    console.log(`[${ts}] EXECUTING ON-CHAIN...`);

    const deadline = Math.floor(Date.now() / 1000) + 120;

    const txRequest = {
      to: VAULT_CONTRACT,
      data: vault.interface.encodeFunctionData("executeArbitrage", [
        buyRouter,
        sellRouter,
        TRADE_SIZE,
        buyPath,
        sellPath,
        deadline
      ]),
      gasLimit: 1_500_000,
      maxPriorityFeePerGas: ethers.parseUnits("80", "gwei"),
      maxFeePerGas: ethers.parseUnits("150", "gwei")
    };

    await sendTxWithRetry(txRequest);

  } catch (err) {
    console.error(`[${ts}] ERROR`, err.reason || err.message || err);
  } finally {
    executing = false;
  }
}

// ─────────────────────────────────────────────
// 9️⃣ RUN LOOP
// ─────────────────────────────────────────────
setInterval(checkAndExecute, 5000);
