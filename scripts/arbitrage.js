// File: scripts/arbitrage.js
// Drop-in replacement with reliability hardening while preserving existing logic structure.
// All enhancements are additive and aim at resilience.

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= STARTUP CHECKS (from JS1) ================= */

if (!process.env.RPC_URL?.trim() || !process.env.PRIVATE_KEY?.trim()) process.exit(1);

console.log("✅ RPC_URL active");
console.log("✅ PRIVATE_KEY active");

/* ================= ENV ================= */
let RPC_POLYGON_WS = process.env.RPC_URL?.trim();
let WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();

if (!RPC_POLYGON_WS) {
  console.error("❌ RPC_URL is missing.");
  process.exit(1);
}

if (!WALLET_PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY is missing.");
  process.exit(1);
}

if (!/^0x[a-fA-F0-9]{64}$/.test(WALLET_PRIVATE_KEY)) {
  console.error("❌ Invalid private key format.");
  process.exit(1);
}

console.log("✅ RPC_URL active");
console.log("✅ PRIVATE_KEY active");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const BRIGHT_GREEN = "\x1b[1;92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

/* ================= PARAMETERS ================= */
const MIN_TRADE_USDC = 10000;
const MIN_EXPECTED_PROFIT = 0.000001;
const PROFIT_SAFETY_MULTIPLIER = 0.9;
const DEADLINE_SECONDS = 60;
const PARALLEL_LIMIT = 10;
const SCAN_INTERVAL_MS = 30000;

/* ================= PROVIDER ================= */
let provider = new ethers.WebSocketProvider(RPC_POLYGON_WS);

provider._websocket?.on("close", () =>
  console.error("❌ WebSocket connection closed.")
);
provider._websocket?.on("error", (err) =>
  console.error("❌ WebSocket error:", err?.message || err)
);

let wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= FLASH VAULT ================= */
const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)",
  "function balanceOf(address) view returns(uint256)"
];

let vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:     "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

// routerContracts is mutable to allow rebind on reconnect
let routerContracts = Object.fromEntries(
  Object.entries(routers).map(([k, v]) => [k, new ethers.Contract(v, routerAbi, provider)])
);

/* ================= TOKENS ================= */
const TOKENS = {
  USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE:    "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV:    "0xD533a9497406805d9725bC53FBf3EcdEa7302A6",
  DAI:    "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK:   "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE:   "0xD6DF932A45C0f255f85145f286Ea0B292b21C90b"
};

/* ================= HELPERS ================= */
function timestamp() {
  return `[${new Date().toLocaleTimeString()}]`;
}

async function quote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

function buildPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token],
    [usdc, TOKENS.USDT, token],
    [usdc, TOKENS.DAI, token]
  ];
}

function buildSellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc],
    [token, TOKENS.USDT, usdc],
    [token, TOKENS.DAI, usdc]
  ];
}

async function vaultWillExecute(args) {
  try {
    await vault.executeFlashArbitrage.staticCall(...args);
    return true;
  } catch {
    return false;
  }
}

/* ================= ARBITRAGE ================= */
async function tryArb(buyRouterName, sellRouterName, amountIn, path, sellPath) {
  try {
    const buyRouter = routerContracts[buyRouterName];
    const sellRouter = routerContracts[sellRouterName];

    const buyOutput = await withRetry(() => quote(buyRouter, amountIn, path), {
      retries: 3,
      delayMs: 500,
      backoff: 2
    });

    if (!buyOutput) {
      console.log(`${timestamp()} ❌ Unable to quote buy path`);
      return null;
    }

    const sellOutput = await withRetry(() => quote(sellRouter, buyOutput, sellPath), {
      retries: 3,
      delayMs: 500,
      backoff: 2
    });

    if (sellOutput && sellOutput.gt(0)) {
      const amountInWei = amountIn;
      const pathBuy = path;
      const pathSell = sellPath;

      const tx = await withRetry(
        () =>
          vault.executeFlashArbitrage(
            routers[buyRouterName],
            routers[sellRouterName],
            amountIn,
            pathBuy,
            pathSell,
            Math.floor(DEADLINE_SECONDS)
          ),
        { retries: 3, delayMs: 1000, backoff: 2 }
      );

      console.log(`${timestamp()} ✅ Arb tx submitted: ${tx?.hash ?? "unknown"}`);
      return tx;
    } else {
      console.log(`${timestamp()} ℹ️ No profitable arb found for this cycle.`);
      return null;
    }
  } catch (e) {
    console.error(`${timestamp()} ❌ tryArb failed: ${e?.message ?? e}`);
    return null;
  }
}

/* ================= SCAN LOOP (reliable, never stops) ================= */
async function performScanCycle() {
  try {
    const buyRouterName = "QuickSwap";
    const sellRouterName = "SushiSwap";
    const amountIn = ethers.utils.parseUnits("1000", 6);
    const path = [ TOKENS.USDT, TOKENS.WETH ];
    const sellPath = [ TOKENS.WETH, TOKENS.USDT ];

    await withRetry(
      () => tryArb(buyRouterName, sellRouterName, amountIn, path, sellPath),
      { retries: 2, delayMs: 500, backoff: 2 }
    );
  } catch (e) {
    console.error(`${timestamp()} ❌ Scan cycle error: ${e?.message ?? e}`);
  }
}

/* ================= GAS/NONCE SAFE SENDING (helper) ================= */
async function safeSendTx(rawTx) {
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const tx = { ...rawTx, nonce };
  if (!tx.gasPrice) {
    tx.gasPrice = await provider.getGasPrice();
  }
  if (!tx.gasLimit) {
    try {
      tx.gasLimit = await wallet.estimateGas(tx);
    } catch {
      tx.gasLimit = ethers.BigNumber.from("100000");
    }
  }
  return wallet.sendTransaction(tx);
}

/* ================= TIMEOUT WRAPPER ================= */
async function withTimeout(promise, ms) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) =>
    timeout = setTimeout(() => reject(new Error("Operation timed out")), ms)
  );
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeout);
    return result;
  } catch (e) {
    throw e;
  }
}

/* ================= RECONNECTABLE PROVIDER (robust) ================= */
async function recreateProviderIfNeeded() {
  const isOpen = provider._websocket?.readyState === 1;
  if (!isOpen) {
    console.warn(`${timestamp()} 🔄 Recreating WebSocket provider...`);
    try {
      provider = new ethers.WebSocketProvider(RPC_POLYGON_WS);
      const newWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

      vault = vault.connect(newWallet);
      routerContracts = Object.fromEntries(
        Object.entries(routers).map(([k, v]) => [k, new ethers.Contract(v, routerAbi, provider)])
      );

      wallet = newWallet;
      console.log(`${timestamp()} ✅ Reconnected WebSocket provider`);
    } catch (e) {
      console.error(`${timestamp()} ❌ WebSocket reconnect failed: ${e?.message ?? e}`);
    }
  }
}

/* ================= MAIN LOOP (reliable, never stops) ================= */
async function mainLoop() {
  while (true) {
    try {
      await recreateProviderIfNeeded();
      await performScanCycle();
    } catch (e) {
      console.error(`${timestamp()} ❌ Main loop error: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

/* ================= START ================= */
(async () => {
  console.log(`${timestamp()} 🚀 Starting arbitrage bot with reliability hardening`);
  try {
    const usdcAddress = await vault.usdc();
    const bal = await vault.balanceOf(wallet.address);
    console.log(`${timestamp()} 🧭 Sanity check: vault USDC=${usdcAddress}, balance=${bal.toString()}`);
  } catch (e) {
    console.error(`${timestamp()} ❗ Sanity check failed: ${e?.message ?? e}`);
  }

  await mainLoop();
})();

async function withRetry(promiseFn, opts = {}) {
  const {
    retries = 5,
    delayMs = 1000,
    backoff = 1.5,
    shouldRetry = (e) => true
  } = opts;

  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await promiseFn();
    } catch (e) {
      lastErr = e;
      if (!shouldRetry(e) || attempt === retries) {
        throw e;
      }
      const wait = Math.max(0, Math.round(delayMs * Math.pow(backoff, attempt)));
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
    }
  }
  throw lastErr;
}
