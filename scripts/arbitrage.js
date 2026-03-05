import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= CONFIG ================= */
const RPC_LIST = (
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  ""
)
  .split(",")
  .map(rpc => rpc.trim())
  .filter(Boolean);

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

if (!RPC_LIST.length) throw new Error("No RPC endpoints provided");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");

const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || .4);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.0005);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 2000);
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
const DRY_RUN = (process.env.DRY_RUN || "false") === "true";

/* ================= TIMESTAMP & LOG HELPERS ================= */
const ts = () => new Date().toISOString();

/* ================= PROVIDER (RPC FAILOVER) ================= */
async function getWorkingProvider() {
  for (const rpc of RPC_LIST) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      console.log(`[${ts()}] ✅ Connected RPC: ${rpc}`);
      return provider;
    } catch {
      console.log(`[${ts()}] ⚠️ RPC failed: ${rpc}`);
    }
  }
  throw new Error("All RPC endpoints failed");
}

const provider = await getWorkingProvider();
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const vaultAbi = [
  {
    name: "executeArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ]
  },
  {
    name: "usdc",
    type: "function",
    stateMutability: "view",
    outputs: [{ type: "address" }]
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= SYMBOL MAPPING ================= */
const TOKEN_SYMBOLS = Object.fromEntries(
  Object.entries(TOKENS).map(([sym, addr]) => [addr.toLowerCase(), sym])
);

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quote(router, amountIn, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const amounts = await r.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

function symbol(addr) {
  return TOKEN_SYMBOLS[addr.toLowerCase()] || addr.slice(0,6) + "…" + addr.slice(-4);
}

async function vaultUSDCBalance() {
  const usdcAddress = await vault.usdc();
  const usdcContract = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);
  return Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
}

/* ================= ARB CHECK ================= */
async function checkArb(buyRouter, sellRouter, tokenAddr, usdc) {
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);
  const buyPath = [usdc, tokenAddr];
  const sellPath = [tokenAddr, usdc];

  console.log(`[${ts()}] 🔎 SCAN | Token ${symbol(tokenAddr)} | Buy ${symbol(buyRouter)} → Sell ${symbol(sellRouter)}`);

  const buyOut = await quote(buyRouter, amountIn, buyPath);
  if (!buyOut) return null;

  const sellOut = await quote(sellRouter, buyOut, sellPath);
  if (!sellOut) return null;

  const received = Number(ethers.formatUnits(sellOut, 6));
  const profit = received - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return null;

  return {
    buyRouter,
    sellRouter,
    tokenAddr,
    buyPath,
    sellPath,
    profit
  };
}

/* ================= EXECUTION QUEUE ================= */
const executionQueue = [];
let executing = false;

async function processQueue() {
  if (executing) return;
  executing = true;

  while (executionQueue.length) {
    const arb = executionQueue.shift();
    console.log(`[${ts()}] 🔥 EXECUTING | Token ${symbol(arb.tokenAddr)} | Profit: +${arb.profit.toFixed(6)} USDC`);

    if (DRY_RUN) {
      console.log(`[${ts()}] 🧪 DRY RUN — skipped tx`);
      continue;
    }

    try {
      const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
      const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

      const tx = await vault.executeArbitrage(
        arb.buyRouter,
        arb.sellRouter,
        amountIn,
        arb.buyPath,
        arb.sellPath,
        deadline
      );

      console.log(`[${ts()}] ⛓ TX SENT: ${tx.hash}`);
      await tx.wait();
      console.log(`[${ts()}] ✅ TX CONFIRMED`);

      const updatedVaultBalance = await vaultUSDCBalance();
      const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));

      console.log(`[${ts()}] 💰 Vault USDC balance: ${updatedVaultBalance.toFixed(6)} | Wallet MATIC: ${walletMatic.toFixed(6)}`);
    } catch (e) {
      console.log(`[${ts()}] ⚠️ TX FAILED: ${e.message}`);
    }
  }

  executing = false;
}

/* ================= PARALLEL SCANNER ================= */
async function runWithConcurrency(tasks, limit) {
  const pool = [];
  for (const task of tasks) {
    const p = task();
    pool.push(p);
    if (pool.length >= limit) {
      await Promise.race(pool);
      pool.splice(pool.findIndex(x => x === p), 1);
    }
  }
  await Promise.allSettled(pool);
}

/* ================= SCAN ================= */
async function scan() {
  const usdc = await vault.usdc();
  const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
  const vaultBalance = await vaultUSDCBalance();

  console.log(`[${ts()}] 💎 Wallet MATIC balance: ${walletMatic.toFixed(6)} | Vault USDC balance: ${vaultBalance.toFixed(6)}`);

  const tasks = [];
  const found = [];

  for (const [sym, tokenAddr] of Object.entries(TOKENS)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyRouter === sellRouter) continue;

        tasks.push(async () => {
          const arb = await checkArb(buyRouter, sellRouter, tokenAddr, usdc);
          if (arb) found.push(arb);
        });
      }
    }
  }

  await runWithConcurrency(tasks, SCAN_CONCURRENCY);

  found
    .sort((a, b) => b.profit - a.profit)
    .forEach(a => executionQueue.push(a));

  if (found.length) {
    console.log(`[${ts()}] 💡 ${found.length} profitable arbs queued`);
    processQueue();
  }
}

/* ================= MAIN LOOP ================= */
(async () => {
  console.log(`[${ts()}] 🚀 Parallel Arbitrage Bot Started (RPC Failover Enabled)`);

  let cycle = 0;
  while (true) {
    cycle++;
    try {
      console.log(`[${ts()}] 🔄 Scan cycle ${cycle} started`);
      await scan();
      console.log(`[${ts()}] ✅ Scan cycle ${cycle} completed`);
    } catch (e) {
      console.log(`[${ts()}] ⚠️ Scan error: ${e.message}`);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
