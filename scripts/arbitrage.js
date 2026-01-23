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

const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 1); // USDC per trade
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.00001);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 1000);
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
const DRY_RUN = (process.env.DRY_RUN || "false") === "true";
const TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 2);

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
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  KyberSwap: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= SYMBOL MAPPINGS ================= */
const TOKEN_SYMBOLS = Object.fromEntries(
  Object.entries(TOKENS).map(([sym, addr]) => [addr.toLowerCase(), sym])
);

const DEX_SYMBOLS = Object.fromEntries(
  Object.entries(routers).map(([name, addr]) => [addr.toLowerCase(), name])
);

function symbol(addr) {
  return TOKEN_SYMBOLS[addr.toLowerCase()] || addr.slice(0,6) + "…" + addr.slice(-4);
}

function dexSymbol(addr) {
  return DEX_SYMBOLS[addr.toLowerCase()] || addr.slice(0,6) + "…" + addr.slice(-4);
}

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

async function vaultUSDCBalance() {
  const usdcAddress = await vault.usdc();
  const usdcContract = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);
  return Number(ethers.formatUnits(await usdcContract.balanceOf(VAULT_ADDRESS), 6));
}

/* ================= PATH GENERATION (MULTI-HOP) ================= */
const FALLBACK_HOPS = [TOKENS.WETH, TOKENS.DAI, TOKENS.USDT, TOKENS.WMATIC];

function generatePaths(base, token) {
  const paths = [];
  // direct
  paths.push([base, token]);
  // single-hop
  for (const hop of FALLBACK_HOPS) {
    if (hop !== token && hop !== base) paths.push([base, hop, token]);
  }
  // double-hop
  for (const hop1 of FALLBACK_HOPS) {
    for (const hop2 of FALLBACK_HOPS) {
      if (hop1 !== hop2 && hop1 !== token && hop2 !== token && hop1 !== base && hop2 !== base)
        paths.push([base, hop1, hop2, token]);
    }
  }
  return paths;
}

/* ================= ARB CHECK ================= */
async function checkArb(buyRouter, sellRouter, tokenAddr, usdcAddr) {
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);
  const buyPaths = generatePaths(usdcAddr, tokenAddr);
  const sellPaths = generatePaths(tokenAddr, usdcAddr);

  for (const buyPath of buyPaths) {
    for (const sellPath of sellPaths) {
      console.log(`[${ts()}] 🔎 SCAN | Token ${symbol(tokenAddr)} | Buy ${dexSymbol(buyRouter)} → Sell ${dexSymbol(sellRouter)}`);

      const buyOut = await quote(buyRouter, amountIn, buyPath);
      if (!buyOut) continue;

      const sellOut = await quote(sellRouter, buyOut, sellPath);
      if (!sellOut) continue;

      const received = Number(ethers.formatUnits(sellOut, 6));
      const profit = received - MIN_TRADE_USDC;
      if (profit >= MIN_EXPECTED_PROFIT) {
        return { buyRouter, sellRouter, tokenAddr, buyPath, sellPath, profit };
      }
    }
  }
  return null;
}

/* ================= EXECUTION QUEUE ================= */
const executionQueue = [];
let executing = false;

async function processQueue() {
  if (executing) return;
  executing = true;

  while (executionQueue.length) {
    const arb = executionQueue.shift();

    console.log(`[${ts()}] 🔥 EXECUTING | Token ${symbol(arb.tokenAddr)} | Buy ${dexSymbol(arb.buyRouter)} → Sell ${dexSymbol(arb.sellRouter)} | Profit: +${arb.profit.toFixed(6)} USDC`);

    if (!DRY_RUN) {
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
      } catch (e) {
        console.log(`[${ts()}] ⚠️ TX FAILED: ${e.message}`);
      }
    } else {
      console.log(`[${ts()}] 🧪 DRY RUN — skipped tx`);
    }

    const updatedVaultBalance = await vaultUSDCBalance();
    const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
    console.log(`[${ts()}] 💰 Vault USDC balance: ${updatedVaultBalance.toFixed(6)} | Wallet MATIC: ${walletMatic.toFixed(6)}`);
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

  for (const tokenAddr of Object.values(TOKENS)) {
    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {
        if (buyRouter === sellRouter) continue;
        tasks.push(async () => {
          const arb = await checkArb(buyRouter, sellRouter, tokenAddr, usdc);
          if (arb) found.push(arb);
        });
      }
    }
  }

  await runWithConcurrency(tasks, SCAN_CONCURRENCY);

  found.sort((a, b) => b.profit - a.profit).forEach(a => executionQueue.push(a));
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
