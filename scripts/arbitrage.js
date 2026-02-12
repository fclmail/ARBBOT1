// scripts/arbitrage_flash_ws.js

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const RPC_POLYGON_WS = (process.env.RPC_POLYGON_WS || "").trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || "").trim();

if (!RPC_POLYGON_WS) throw new Error("RPC_POLYGON_WS missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= PARAMETERS ================= */
const MIN_TRADE_USDC = 2000; // Minimum arb trade in USDC
const MIN_EXPECTED_PROFIT = 0.000001;
const PROFIT_SAFETY_MULTIPLIER = 0.9;
const DEADLINE_SECONDS = 60;
const PARALLEL_LIMIT = 10; // Prevent too many parallel requests

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.WebSocketProvider(RPC_POLYGON_WS);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= FLASH VAULT ================= */
const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";
const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)"
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:     "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};
const routerAbi = ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"];

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

/* ================= ERC20 ================= */
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
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

/* ================= SIMULATION ================= */
async function vaultWillExecute(args) {
  try {
    await vault.executeFlashArbitrage.staticCall(...args);
    return true;
  } catch {
    return false;
  }
}

/* ================= ARBITRAGE CORE ================= */
async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdcAddr = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut, bestBuyPath;
  for (const p of buildPaths(usdcAddr, tokenAddr)) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyOut) return;

  let bestSellOut, bestSellPath;
  for (const p of buildSellPaths(usdcAddr, tokenAddr)) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }
  if (!bestSellOut) return;

  const grossProfit =
    Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

  const safeProfit = grossProfit * PROFIT_SAFETY_MULTIPLIER;
  if (safeProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`${GREEN}🔥 Flash profit:${RESET} ${safeProfit.toFixed(6)} USDC`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const args = [
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    deadline
  ];

  if (!(await vaultWillExecute(args))) return;

  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const tx = await vault.executeFlashArbitrage(...args, { nonce, gasLimit: 2_000_000 });
  await tx.wait();
  console.log(`${GREEN}⚡ Flash executed | ${tx.hash}${RESET}`);
}

/* ================= MEMPOOL SCANNER ================= */
async function startMempoolScanner() {
  console.log("🚀 Listening to Polygon mempool...");

  provider.on("pending", async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.to) return;

      // Only consider DEX routers
      if (!Object.values(routers).includes(tx.to)) return;

      console.log(`⚡ Pending swap detected: ${txHash}`);

      // Execute all token/router combos in parallel (throttle to PARALLEL_LIMIT)
      const tasks = [];
      for (const token of Object.values(TOKENS)) {
        for (const buy of Object.values(routers)) {
          for (const sell of Object.values(routers)) {
            if (buy !== sell) {
              tasks.push(tryArb(buy, sell, token));
              if (tasks.length >= PARALLEL_LIMIT) {
                await Promise.allSettled(tasks);
                tasks.length = 0;
              }
            }
          }
        }
      }
      if (tasks.length) await Promise.allSettled(tasks);

    } catch (err) {
      console.error(RED, err, RESET);
    }
  });
}

/* ================= START ================= */
startMempoolScanner().catch(console.error);
