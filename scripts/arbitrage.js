// scripts/arbitrage_flash.js

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const RPC_POLYGON = (
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  ""
).trim();

const WALLET_PRIVATE_KEY = (
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  ""
).trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= PARAMS ================= */

const MIN_TRADE_USDC = 2000;
const MIN_EXPECTED_PROFIT = 0.000001;
const PROFIT_SAFETY_MULTIPLIER = 0.9;
const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= FLASH VAULT ================= */

const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256)",
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256) view",
  "function usdc() view returns(address)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:    "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS (9) ================= */

const TOKENS = {
  USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE:   "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV:   "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI:   "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK:  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE:  "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
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

/* ================= PATH BUILDERS (8) ================= */

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
    console.log(`${GREEN}🧪 FLASH SIM PASSED${RESET}`);
    return true;
  } catch (e) {
    console.log(`${RED}🧪 FLASH SIM FAILED${RESET}`);
    console.log(e?.shortMessage || e?.reason || e?.error?.message || e);
    return false;
  }
}

/* ================= BALANCES ================= */

async function logBalances() {
  const maticBal = await provider.getBalance(wallet.address);
  const usdcAddr = await vault.usdc();
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

  console.log(`${CYAN}👛 Wallet:${RESET} ${wallet.address}`);
  console.log(`${YELLOW}⛽ MATIC:${RESET} ${ethers.formatEther(maticBal)}`);
  console.log(`${GREEN}🏦 Vault USDC:${RESET} ${Number(ethers.formatUnits(vaultBal, 6))} USDC`);
}

/* ================= ARB CORE ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut, bestBuyPath;
  for (const p of buildPaths(usdc, tokenAddr)) {
    const out = await quote(buyRouter, amountIn, p);
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

  const grossProfit =
    Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

  const safeProfit = grossProfit * PROFIT_SAFETY_MULTIPLIER;
  if (safeProfit < MIN_EXPECTED_PROFIT) return;

 console.log(`${GREEN}🔥 FLASH PROFIT:${RESET} ${safeProfit.toFixed(6)} USDC`);

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

  const tx = await vault.executeFlashArbitrage(...args);
  await tx.wait();

  console.log(`${GREEN}⚡ FLASH SUCCESS | ${tx.hash}${RESET}`);
}

/* ================= SCANNER ================= */

async function scan() {
  await logBalances();
  console.log(`🔍 Scan @ ${new Date().toISOString()}`);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) await tryArb(buy, sell, token);
        await sleep(100);
      }
    }
  }
}

/* ================= START ================= */

console.log("🚀 Flash Arbitrage Bot Started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
