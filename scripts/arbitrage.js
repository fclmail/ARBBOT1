// ============================================================
// POLYGON ARBITRAGE BOT — SINGLE FILE DROP-IN
// ============================================================

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

// ============================================================
// ENV
// ============================================================

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL;

const WALLET_PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

// ============================================================
// COLORS
// ============================================================

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";

// ============================================================
// SETTINGS
// ============================================================

const MIN_TRADE_USDC = 1.7;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

const WITHDRAW_THRESHOLD_USDC = 1;
const WITHDRAW_PERCENT = 100;

// ============================================================
// PROVIDER + WALLET
// ============================================================

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ============================================================
// VAULT
// ============================================================

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)",
  "function withdrawERC20(address,uint256)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ============================================================
// ROUTERS
// ============================================================

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

// ============================================================
// ROUTER ABI
// ============================================================

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

// ============================================================
// TOKENS (Polygon)
// ============================================================

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

// ============================================================
// HELPERS
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

// ============================================================
// PATH BUILDERS
// ============================================================

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

// ============================================================
// BALANCES
// ============================================================

async function showBalances(usdcAddr) {
  const matic = await provider.getBalance(wallet.address);

  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );

  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

  console.log(
    `${CYAN}Wallet MATIC:${RESET} ${ethers.formatEther(matic)} | ` +
      `${CYAN}Vault USDC:${RESET} ${ethers.formatUnits(vaultBal, 6)}`
  );
}

// ============================================================
// WITHDRAW PROFITS
// ============================================================

async function autoWithdraw(usdcAddr) {
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256)"],
    wallet
  );

  const bal = await usdc.balanceOf(VAULT_ADDRESS);

  if (Number(ethers.formatUnits(bal, 6)) < WITHDRAW_THRESHOLD_USDC) return;

  const amount = (bal * BigInt(WITHDRAW_PERCENT)) / 100n;

  await (await vault.withdrawERC20(usdcAddr, amount)).wait();
  await (await usdc.approve(routers.QuickSwap, amount)).wait();

  const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);

  await (
    await router.swapExactTokensForTokens(
      amount,
      0,
      [usdcAddr, TOKENS.WMATIC],
      wallet.address,
      Math.floor(Date.now() / 1000) + 120
    )
  ).wait();

  console.log(`${GREEN}💸 PROFITS WITHDRAWN → MATIC${RESET}`);
}

// ============================================================
// ARBITRAGE LOGIC
// ============================================================

async function tryArb(buyRouter, sellRouter, token) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut, bestBuyPath;

  for (const p of buildPaths(usdc, token)) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestBuyOut) return;

  let bestSellOut, bestSellPath;

  for (const p of buildSellPaths(usdc, token)) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }

  if (!bestSellOut) return;

  const profit =
    Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log(`${GREEN}🔥 PROFIT ${profit.toFixed(6)} USDCe${RESET}`);

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    deadline
  );
}

// ============================================================
// SCAN LOOP
// ============================================================

async function scan() {
  console.log(`\n🔍 Scan @ ${new Date().toISOString()}`);

  const usdc = await vault.usdc();

  await showBalances(usdc);
  await autoWithdraw(usdc);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) await tryArb(buy, sell, token);
        await sleep(100);
      }
    }
  }
}

// ============================================================
// MAIN
// ============================================================

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
