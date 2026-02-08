import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

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

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";

/* ================= CONSTANTS ================= */

// FIX #1 — real trade size + real profit threshold
const MIN_TRADE_USDC = .90;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

/* ================= WITHDRAW ================= */

const WITHDRAW_THRESHOLD_USDC = 1_000_000;
const WITHDRAW_PERCENT = 100;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

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

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
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

/* ================= PATHS ================= */

// FIX #4 — removed low-value USDT / DAI paths
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

/* ================= DISPLAY ================= */

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

/* ================= SIMULATION ================= */

async function vaultWillExecute(args) {
  console.log(`${YELLOW}🧪 SIMULATION START${RESET}`);
  try {
    await vault.callStatic.executeArbitrage(...args);
    return true;
  } catch {
    return false;
  }
}

/* ================= ARBITRAGE ================= */

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

  const profit =
    Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log(
    `${GREEN}🔥 PROFIT FOUND:${RESET} ${profit.toFixed(4)} USDCe`
  );

  const args = [
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
  ];

  if (!(await vaultWillExecute(args))) return;

  // FIX #2 + #3 — immediate execution, block scan
  const tx = await vault.executeArbitrage(...args);
  await tx.wait();

  console.log(
    `${GREEN}✅ ARBITRAGE EXECUTED — PROFIT DEPOSITED${RESET} | ${tx.hash}`
  );

  return true;
}

/* ================= SCAN ================= */

async function scan() {
  console.log(`🔍 Scan @ ${new Date().toISOString()}`);
  const usdc = await vault.usdc();
  await showBalances(usdc);

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          const executed = await tryArb(buy, sell, token);
          if (executed) return;
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

// FIX #3 — no overlapping scans
console.log("🚀 Arbitrage bot started");

(async function mainLoop() {
  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
})();
