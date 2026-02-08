// 1) IMPORTS AND ENV  

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

// 2) ENV VARIABLES  

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

// 3) COLORS  

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";

// 4) CONSTANTS  

// SMART CONTRACT: minimum profit = 1 = 0.000001 USDCe  
const MIN_TRADE_USDC = 1.7;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

// 5) WITHDRAW CONFIG  

const WITHDRAW_THRESHOLD_USDC = 1;
const WITHDRAW_PERCENT = 100;

// 6) PROVIDER AND WALLET  

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// 7) VAULT CONTRACT  

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  {
    name: "executeArbitrage",
    type: "function",
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    name: "usdc",
    type: "function",
    outputs: [{ type: "address" }],
    stateMutability: "view"
  },
  {
    name: "withdrawERC20",
    type: "function",
    inputs: [
      { name: "tokenAddr", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// 8) ROUTERS  

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

// 9) ROUTER ABI  

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

// 10) TOKENS  

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab291
...
};

// 11) HELPERS  

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

// 12) PATHS BUILDER  

function buildPaths(usdc, tokenAddr) {
  return [
    [usdc, tokenAddr],
    [usdc, TOKENS.WMATIC, tokenAddr],
    [usdc, TOKENS.WETH, tokenAddr],
    [usdc, TOKENS.USDT, tokenAddr],
    [usdc, TOKENS.DAI, tokenAddr]
  ];
}

function buildSellPaths(usdc, tokenAddr) {
  return [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ];
}

// 13) DISPLAY BALANCES  

async function showBalances(usdcAddr) {
  const matic = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );
  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

  console.log(
    `${CYAN}💰 Wallet MATIC:${RESET} ${ethers.formatEther(matic)} | ` +
    `${CYAN}Vault USDC:${RESET} ${ethers.formatUnits(vaultBal, 6)}`
  );
}

// 14) WITHDRAW LOGIC  

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

// 15) SIMULATION CHECK  

async function vaultWillExecute(args) {
  console.log(`${YELLOW}🧪 SIMULATION START${RESET}`);
  try {
    await vault.callStatic.executeArbitrage(...args);
    console.log(`${GREEN}🧪 SIMULATION PASSED${RESET}`);
    return true;
  } catch {
    return false;
  }
}

// 16) ARBITRAGE TRY LOGIC  

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
...
  }
  if (!bestSellOut) return;

  const profit = Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;
  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log(
    `${GREEN}🔥 PROFIT FOUND:${RESET} ` +
    `${GREEN}${profit.toFixed(6)} USDCe${RESET}`
  );

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

  const tx = await vault.executeArbitrage(...args);

  tx.wait().then(() => {
    console.log(`${GREEN}✅ PROFITS DEPOSITED INTO VAULT${RESET} | ${tx.hash}`);
  });
}

/* ================= SCAN ================= */

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

/* ================= MAIN ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
