// scripts/arbitrage.js

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const RPC_POLYGON_WS = process.env.RPC_URL?.trim();
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();

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
const MIN_TRADE_USDC = 10;
const MIN_EXPECTED_PROFIT = 0.000001;
const PROFIT_SAFETY_MULTIPLIER = 0.9;
const DEADLINE_SECONDS = 60;
const PARALLEL_LIMIT = 15;
const SCAN_INTERVAL_MS = 30000;

/* ================= PROVIDER ================= */
const provider = new ethers.WebSocketProvider(RPC_POLYGON_WS);

provider._websocket?.on("close", () =>
  console.error("❌ WebSocket connection closed.")
);
provider._websocket?.on("error", (err) =>
  console.error("❌ WebSocket error:", err?.message || err)
);

const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= FLASH VAULT ================= */
const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)",
  "function balanceOf(address) view returns(uint256)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

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

const routerContracts = Object.fromEntries(
  Object.entries(routers).map(([k, v]) => [k, new ethers.Contract(v, routerAbi, provider)])
);

/* ================= TOKENS ================= */
const TOKENS = {
  USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE:    "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV:    "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK:   "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE:   "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
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
async function tryArb(buyRouterName, sellRouterName, tokenAddr) {
  try {
    const usdcAddr = await vault.usdc();
    const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

    const buyRouter = routerContracts[buyRouterName];
    const sellRouter = routerContracts[sellRouterName];

    const buyPaths = buildPaths(usdcAddr, tokenAddr);
    const buyQuotes = await Promise.all(buyPaths.map(p => quote(buyRouter, amountIn, p)));

    let bestBuyOut, bestBuyPath;
    buyQuotes.forEach((out, i) => {
      if (out && (!bestBuyOut || out > bestBuyOut)) {
        bestBuyOut = out;
        bestBuyPath = buyPaths[i];
      }
    });
    if (!bestBuyOut || bestBuyOut > 1e12) return;

    const sellPaths = buildSellPaths(usdcAddr, tokenAddr);
    const sellQuotes = await Promise.all(sellPaths.map(p => quote(sellRouter, bestBuyOut, p)));

    let bestSellOut, bestSellPath;
    sellQuotes.forEach((out, i) => {
      if (out && (!bestSellOut || out > bestSellOut)) {
        bestSellOut = out;
        bestSellPath = sellPaths[i];
      }
    });
    if (!bestSellOut || bestSellOut > 1e12) return;

    const gross = Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;
    const profit = gross * PROFIT_SAFETY_MULTIPLIER;

    const logColor = profit > 0 ? BRIGHT_GREEN : RED;
    console.log(`${timestamp()} ${logColor}Scan | Buy:${buyRouterName} ${Number(ethers.formatUnits(bestBuyOut, 6)).toFixed(6)} | Sell:${sellRouterName} ${Number(ethers.formatUnits(bestSellOut, 6)).toFixed(6)} | Profit:${profit.toFixed(6)} USDC${RESET}`);

    if (profit < MIN_EXPECTED_PROFIT) return;

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
    const args = [routers[buyRouterName], routers[sellRouterName], amountIn, bestBuyPath, bestSellPath, deadline];

    if (!(await vaultWillExecute(args))) return;

    const nonce = await provider.getTransactionCount(wallet.address, "pending");
    const tx = await vault.executeFlashArbitrage(...args, { nonce, gasLimit: 2_000_000 });
    await tx.wait();

    console.log(`${timestamp()} ${GREEN}⚡ Flash executed | TX: ${tx.hash}${RESET}`);

  } catch (err) {
    console.error(RED, "[tryArb Error]", err.message || err, RESET);
  }
}

/* ================= SAFE BATCHING ================= */
async function batchPromises(tasks, limit = PARALLEL_LIMIT) {
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = tasks.slice(i, i + limit).map(fn => fn());
    await Promise.allSettled(batch);
  }
}

/* ================= CONTINUOUS LOOP ================= */
async function continuousScanLoop() {
  const tokens = Object.values(TOKENS);
  const routerKeys = Object.keys(routers);

  console.log(`🚀 Continuous arbitrage scanning | ${tokens.length * routerKeys.length * (routerKeys.length-1)} pairs`);

  while (true) {
    try {
      const tasks = [];
      for (const token of tokens) {
        for (const buy of routerKeys) {
          for (const sell of routerKeys) {
            if (buy !== sell) tasks.push(() => tryArb(buy, sell, token));
          }
        }
      }
      await batchPromises(tasks);

      await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
    } catch (loopErr) {
      console.error(RED, "[Loop Error]", loopErr.message || loopErr, RESET);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

/* ================= START ================= */
continuousScanLoop();
