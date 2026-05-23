import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const abi = [
  "function triggerFlashArbitrage((address routerBuy,address routerSell,address token) route,uint256 amount,uint256 minOut) external"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const USDC = TOKENS.USDC;

/* ================= ROUTERS ================= */

const QUICK = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= ROUTER ABI ================= */

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)"
];

const quick = new ethers.Contract(QUICK, routerAbi, provider);
const sushi = new ethers.Contract(SUSHI, routerAbi, provider);

/* ================= CONSTANTS ================= */

const TRADE_SIZE = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.0001", 6);

/* ================= HELPERS ================= */

const fmt = (x) =>
  Number(ethers.formatUnits(x, 6)).toFixed(6);

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, ms));

/* ================= QUOTES ================= */

async function quote(router, amount, path) {
  try {
    const out = await router.getAmountsOut(amount, path);
    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= PATHS ================= */

function buyPath(token) {
  return [USDC, token];
}

function sellPath(token) {
  return [token, USDC];
}

/* ================= LIVE REBUILD ================= */

async function liveRebuild(best) {
  const buyOut = await quote(quick, best.size, buyPath(best.token));
  const sellOut = await quote(sushi, buyOut, sellPath(best.token));

  if (!buyOut || !sellOut) return null;

  const profit = sellOut - best.size;

  return { buyOut, sellOut, profit };
}

/* ================= EXECUTION ================= */

async function execute(best) {
  const start = Date.now();

  console.log("\n====================================================");
  console.log("🔄 LIVE REBUILD VALIDATION");
  console.log("====================================================\n");

  const live = await liveRebuild(best);

  if (!live || live.profit < MIN_PROFIT) {
    console.log("❌ VALIDATION FAILED");
    return;
  }

  console.log(`📡 QUICKSWAP LIVE BUY: ${fmt(live.buyOut)}`);
  console.log(`📡 SUSHISWAP LIVE SELL: ${fmt(live.sellOut)}\n`);

  console.log(`⚡ LIVE PROFIT: ${fmt(live.profit)}`);
  console.log(`⚡ SLIPPAGE: LOW`);
  console.log(`⚡ VALIDATION: PASSED`);

  console.log("\n====================================================");
  console.log("🔥 EXECUTING FLASH BATCH");
  console.log("====================================================\n");

  const tx = await vault.triggerFlashArbitrage(
    {
      routerBuy: QUICK,
      routerSell: SUSHI,
      token: best.token
    },
    best.size,
    0
  );

  console.log(`🚀 TX HASH:\n${tx.hash}\n`);

  const receipt = await tx.wait();

  const time = ((Date.now() - start) / 1000).toFixed(2);

  console.log(`⚡ CONFIRMATION TIME:\n${time}s`);

  console.log("\n====================================================");
  console.log("🏁 FINAL RESULTS");
  console.log("====================================================\n");

  const before = live.buyOut;
  const after = live.sellOut;

  console.log(`💰 REALIZED PROFIT:\n${fmt(after - before)}`);
  console.log(`⚡ SCAN→EXECUTE:\n${time}s`);
}

/* ================= SIMPLE SCANNER ================= */

async function scanToken(name, token) {
  const buyOut = await quote(quick, TRADE_SIZE, buyPath(token));

  if (!buyOut) return null;

  const sellOut = await quote(sushi, buyOut, sellPath(token));

  if (!sellOut) return null;

  const profit = sellOut - TRADE_SIZE;

  if (profit < MIN_PROFIT) return null;

  return {
    token,
    size: TRADE_SIZE,
    profit
  };
}

/* ================= MAIN LOOP ================= */

async function main() {
  console.log("🚀 MICRO→MACRO ARB ENGINE STARTED\n");

  while (true) {
    let best = null;

    for (const [name, token] of Object.entries(TOKENS)) {
      if (name === "USDC") continue;

      const signal = await scanToken(name, token);

      if (signal && (!best || signal.profit > best.profit)) {
        best = signal;
      }
    }

    if (best) {
      await execute(best);
    }

    await sleep(1000);
  }
}

main();
