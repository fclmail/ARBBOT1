// scripts/arbitrage.js
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ============== ENV CONFIG ============== */

// HARDCODED POLYGON RPC (as requested)
const RPC_POLYGON = "https://polygon-rpc.com";

// FLEXIBLE PRIVATE KEY SUPPORT
const WALLET_PRIVATE_KEY = (
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  process.env.PK ||
  ""
).trim();

if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");

/* ============== CONSTANTS ============== */

const MIN_TRADE_USDC = 25.0;
const MIN_EXPECTED_PROFIT = 0.08;
const DEADLINE_SECONDS = 60;

const PARALLEL_BATCH_SIZE = 12;

/* ============== PROVIDER ============== */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ============== CONTRACT ============== */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ============== ROUTERS ============== */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ============== TOKENS ============== */

const TOKENS = {
  USDT:  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WETH:  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI:   "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  AAVE:  "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  LINK:  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  UNI:   "0xb33eaad8d922b1083446dc23f610c2567fb5180f"
};

/* ============== HELPERS ============== */

async function quote(router, amountIn, path) {
  try {
    const c = new ethers.Contract(router, routerAbi, provider);
    const amounts = await c.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ============== PATH ENGINE ============== */

function generatePaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token]
  ];
}

/* ============== ARB CHECK ============== */

async function evaluatePair(buyRouter, sellRouter, token, usdc) {
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const pathsBuy = generatePaths(usdc, token);
  const pathsSell = generatePaths(token, usdc);

  for (let bPath of pathsBuy) {
    for (let sPath of pathsSell) {
      const buyOut = await quote(buyRouter, amountIn, bPath);
      if (!buyOut) continue;

      const sellOut = await quote(sellRouter, buyOut, sPath);
      if (!sellOut) continue;

      const received = Number(ethers.formatUnits(sellOut, 6));
      const profit = received - MIN_TRADE_USDC;

      console.log(
        `\x1b[36m🔎 SCAN | ${token}\n` +
        `  BUY:  ${buyRouter}\n` +
        `  SELL: ${sellRouter}\n` +
        `  PROFIT: ${profit.toFixed(4)} USDC\x1b[0m`
      );

      if (profit >= MIN_EXPECTED_PROFIT) {
        return {
          buyRouter,
          sellRouter,
          amountIn,
          bPath,
          sPath,
          profit
        };
      }
    }
  }

  return null;
}

/* ============== EXECUTE ============== */

async function execute(arb) {
  try {
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

    console.log("\x1b[32m🔥 EXECUTING ARBITRAGE!\x1b[0m");

    const tx = await vault.executeArbitrage(
      arb.buyRouter,
      arb.sellRouter,
      arb.amountIn,
      arb.bPath,
      arb.sPath,
      deadline
    );

    console.log(`⛓ TX SENT: ${tx.hash}`);
    await tx.wait();

    console.log("\x1b[32m✅ PROFIT SECURED TO VAULT\x1b[0m");

  } catch (e) {
    console.log("\x1b[31m❌ EXECUTION FAILED:", e.message, "\x1b[0m");
  }
}

/* ============== SCANNER ============== */

async function scanOnce() {
  const usdc = await vault.usdc();

  const tasks = [];

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;

        tasks.push({ buy, sell, token });
      }
    }
  }

  for (let i = 0; i < tasks.length; i += PARALLEL_BATCH_SIZE) {
    const batch = tasks.slice(i, i + PARALLEL_BATCH_SIZE);

    const results = await Promise.all(
      batch.map(t => evaluatePair(t.buy, t.sell, t.token, usdc))
    );

    const arb = results.find(r => r !== null);

    if (arb) {
      await execute(arb);
      return;
    }
  }
}

/* ============== MAIN LOOP ============== */

(async () => {
  console.log("\x1b[32m🚀 ARBITRAGE BOT STARTED\x1b[0m");

  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.log("Scan error:", e.message);
    }

    await sleep(250);
  }
})();
