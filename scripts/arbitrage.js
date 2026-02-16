import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config();

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const WALLET_PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

/* ================= CONSTANTS ================= */

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x901bFCb41EacB5fB54d89676b45042fABAdb03B9";

const contractAbi = [
  "function executeFlashArbitrage(address,address,address[],address[],uint256) external",
  "function usdc() view returns (address)"
];

const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  contractAbi,
  wallet
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
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

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
    [usdc, TOKENS.WETH, token]
  ];
}

function buildSellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc]
  ];
}

/* ================= ARBITRAGE ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await contract.usdc();

  // Flash amount is fixed inside contract (10,000 USDC)
  const flashAmount = ethers.parseUnits("10000", 6);

  let bestBuyOut, bestBuyPath;

  for (const p of buildPaths(usdc, tokenAddr)) {
    const out = await quote(buyRouter, flashAmount, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestBuyOut) return;

  let bestSellOut, bestSellPath;

  for (const p of buildSellPaths(usdc, tokenAddr)) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }

  if (!bestSellOut) return;

  if (bestSellOut <= flashAmount) return;

  console.log("Profit opportunity found. Executing flash arbitrage...");

  const tx = await contract.executeFlashArbitrage(
    buyRouter,
    sellRouter,
    bestBuyPath,
    bestSellPath,
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
  );

  await tx.wait();

  console.log("FLASH EXECUTED:", tx.hash);
}

/* ================= SCAN ================= */

async function scan() {
  console.log("Scan @", new Date().toISOString());

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          try {
            await tryArb(buy, sell, token);
          } catch (err) {
            console.log("Skipped pair");
          }
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

(async function mainLoop() {
  console.log("Flash arbitrage bot started (10,000 USDC fixed)");

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(e);
    }

    await new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS));
  }
})();
