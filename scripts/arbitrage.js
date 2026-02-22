import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

// ✅ Fetch the private key from environment variables
let WALLET_PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();

// If missing, run in read-only mode instead of crashing
const HAS_PRIVATE_KEY = WALLET_PRIVATE_KEY.length > 0;

if (!HAS_PRIVATE_KEY) {
  console.log("⚠️ PRIVATE_KEY missing — running in SCAN-ONLY mode");
}

/* ================= SETTINGS ================= */

const FIXED_TOTAL_USDC = 10;
const MIN_EXPECTED_PROFIT = 0.00001;
const DEADLINE_SECONDS = 45;
const SCAN_INTERVAL_MS = 8000;

/* ================= PROVIDER ================= */

// Primary and secondary RPC endpoints for resilience
const RPC_ENDPOINTS = [
  // Primary
  "https://polygon-rpc.com",
  // Secondary (backup)
  "https://rpc-mainnet.maticvigil.com"
];

// Create a provider with a simple retryable getJsonRpcProvider
function createProvider(endpoints) {
  // Simple wrapper to cycle endpoints
  let index = 0;

  const provider = new ethers.JsonRpcProvider(endpoints[index], { name: "matic", chainId: 137 });

  // Lightweight health check / endpoint switcher on error
  async function rotateIfNeeded(error) {
    console.error("RPC error detected, attempting fallback. Error:", error?.message ?? error);
    index = (index + 1) % endpoints.length;
  }

  // Attach a proxy to the provider to automatically rotate on fetch errors
  const proxy = new Proxy(provider, {
    get(target, prop) {
      if (prop === "getBlockNumber" || prop === "getNetwork" || prop === "send" || prop === "request") {
        return async (...args) => {
          try {
            // Try the current endpoint
            return await target[prop](...args);
          } catch (e) {
            await rotateIfNeeded(e);
            // Retry with next endpoint
            const nextEndpoint = endpoints[index];
            // Re-create a provider bound to the next endpoint
            const newProvider = new ethers.JsonRpcProvider(nextEndpoint, { name: "matic", chainId: 137 });
            try {
              return await newProvider[prop](...args);
            } catch (err) {
              throw err;
            }
          }
        };
      }
      return target[prop];
    }
  });

  return proxy;
}

const provider = createProvider(RPC_ENDPOINTS);

let wallet = null;
if (HAS_PRIVATE_KEY) {
  wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
}

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256) external"
];

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  vaultAbi,
  HAS_PRIVATE_KEY ? wallet : provider
);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

/* ================= HELPERS ================= */

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch (err) {
    // Provide more context for debugging
    console.error(`Quote error on router ${routerAddr}:`, err?.message ?? err);
    return null;
  }
}

async function getVaultBalance(usdcAddr) {
  try {
    const usdc = new ethers.Contract(
      usdcAddr,
      ["function balanceOf(address) view returns(uint256)"],
      provider
    );
    const bal = await usdc.balanceOf(VAULT_ADDRESS);
    return bal;
  } catch (err) {
    console.error("Failed to fetch vault balance:", err?.message ?? err);
    return null;
  }
}

/* ================= HYBRID ARBITRAGE ================= */

async function tryHybridArb(buyRouter, sellRouter, tokenAddr) {

  // ✅ Hardcoded Polygon USDC
  const usdcAddr = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

  const vaultBalanceRaw = await getVaultBalance(usdcAddr);
  if (vaultBalanceRaw == null) {
    return;
  }

  const vaultBalance = Number(ethers.formatUnits(vaultBalanceRaw, 6));

  // Use a fixed trade amount in USDC (6 decimals)
  const tradeAmount = ethers.parseUnits(FIXED_TOTAL_USDC.toString(), 6);

  const pathToToken = [usdcAddr, tokenAddr];
  const pathToUSDC = [tokenAddr, usdcAddr];

  const expectedBuy = await quote(buyRouter, tradeAmount, pathToToken);
  if (!expectedBuy) return;

  const expectedSell = await quote(sellRouter, expectedBuy, pathToUSDC);
  if (!expectedSell) return;

  const finalOut = Number(ethers.formatUnits(expectedSell, 6));
  const estimatedProfit = finalOut - FIXED_TOTAL_USDC;

  if (estimatedProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`🔥 HYBRID PROFIT FOUND: ${estimatedProfit.toFixed(6)} USDC`);

  if (!HAS_PRIVATE_KEY) {
    console.log("🛑 Skipping execution (no private key)");
    return;
  }

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {
    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      tradeAmount,
      pathToToken,
      pathToUSDC,
      deadline
    );

    console.log(`⛓ TX SENT: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ HYBRID FLASH EXECUTED`);
  } catch (err) {
    console.error("Failed to execute arbitrage transaction:", err?.message ?? err);
  }
}

/* ================= SCAN LOOP ================= */

async function scan() {
  console.log(`\n🔍 Scan @ ${new Date().toISOString()}`);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await tryHybridArb(buy, sell, token);
        }
      }
    }
  }
}

console.log("🚀 Hybrid Arbitrage Bot Started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
