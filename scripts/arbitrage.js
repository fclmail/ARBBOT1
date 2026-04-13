import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= PROCESS ERROR GUARD ================= */

process.on("unhandledRejection", async (err) => {
  const msg = (err?.message || "").toLowerCase();

  if (
    err?.code === "ECONNRESET" ||
    msg.includes("econnreset") ||
    msg.includes("failed to detect network")
  ) {
    console.log("PROCESS RECOVERING FROM RPC FAILURE...");
    await initProvider();
    return;
  }

  throw err;
});

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPCS ================= */

const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.llamarpc.com",
  "https://polygon.drpc.org",
  "https://polygon-public.nodies.app"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.04", 6);
const MIN_PROFIT = ethers.parseUnits("0.00022", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.02", 6);

const DEADLINE_SECONDS = 60;
const WORKER_COUNT = 32;

const RPC_CALL_MAX_RETRIES = 5;
const RPC_BACKOFF_BASE_MS = 250;

/**
 * Execution controls:
 * - sendTx timeout ensures you always print TX hash or fail quickly and rotate RPC.
 */
const SEND_TX_TIMEOUT_MS = 30_000;
const TX_WAIT_TIMEOUT_MS = 120_000;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x8147a186000A5436995E200eF60536237095B164";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

const contractAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS (same as yours) ================= */

const routers = {
  QuickSwap:
    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap:
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn:
    "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird:
    "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap:
    "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:
    "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS (same as yours) ================= */

const TOKENS = {
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
  SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS ================= */

function fmt(x) {
  return ethers.formatUnits(x, 6);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timeout after ${ms}ms`)),
        ms
      )
    )
  ]);
}

/* ================= BATCH STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let isExecuting = false;

/* ================= RPC ================= */

function rebuildContracts() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(
    USDC,
    erc20Abi,
    provider
  );

  vault = new ethers.Contract(
    CONTRACT_ADDRESS,
    contractAbi,
    wallet
  );

  routerContracts = Object.fromEntries(
    Object.values(routers).map((address) => [
      address,
      new ethers.Contract(address, routerAbi, provider)
    ])
  );
}

function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;

  console.log(`ACTIVE RPC -> ${url}`);

  return new ethers.JsonRpcProvider(
    url,
    { name: "matic", chainId: 137 },
    { staticNetwork: true }
  );
}

async function initProvider() {
  provider = newProvider();
  await provider.getNetwork();
  rebuildContracts();
}

function rotateRPC() {
  console.log("RPC FAILED ROTATING...");
  provider = newProvider();
  rebuildContracts();
}

function isRetryableRpcError(e) {
  const msg = (e?.message || "").toLowerCase();

  return (
    e?.code === "ECONNRESET" ||
    msg.includes("timeout") ||
    msg.includes("missing response") ||
    msg.includes("network")
  );
}

async function safeRpc(fn, attempt = 0) {
  try {
    return await fn();
  } catch (e) {
    if (!isRetryableRpcError(e)) throw e;

    console.log(`RPC ERROR: ${e?.message}`);

    if (attempt >= RPC_CALL_MAX_RETRIES) {
      rotateRPC();
      throw e;
    }

    rotateRPC();

    const waitMs =
      RPC_BACKOFF_BASE_MS * (2 ** attempt);

    console.log(
      `RPC retry ${attempt + 1}/${RPC_CALL_MAX_RETRIES} in ${waitMs}ms`
    );

    await sleep(waitMs);

    return safeRpc(fn, attempt + 1);
  }
}

/* ================= QUOTES ================= */

async function quote(router, amount, path) {
  try {
    const out = await safeRpc(() =>
      routerContracts[router].getAmountsOut(
        amount,
        path
      )
    );

    return out.at(-1);
  } catch {
    return null;
  }
}

/* ================= HOPS ================= */

function buildBuyPaths(token) {
  const paths = [[USDC, token]];

  if (token !== TOKENS.WETH)
    paths.push([USDC, TOKENS.WETH, token]);

  if (token !== TOKENS.WMATIC)
    paths.push([USDC, TOKENS.WMATIC, token]);

  if (token !== TOKENS.DAI)
    paths.push([USDC, TOKENS.DAI, token]);

  if (token !== TOKENS.USDT)
    paths.push([USDC, TOKENS.USDT, token]);

  return paths;
}

function buildSellPaths(token) {
  const paths = [[token, USDC]];

  if (token !== TOKENS.WETH)
    paths.push([token, TOKENS.WETH, USDC]);

  if (token !== TOKENS.WMATIC)
    paths.push([token, TOKENS.WMATIC, USDC]);

  if (token !== TOKENS.DAI)
    paths.push([token, TOKENS.DAI, USDC]);

  if (token !== TOKENS.USDT)
    paths.push([token, TOKENS.USDT, USDC]);

  return paths;
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, token) {
  const buyPaths = buildBuyPaths(token);
  const sellPaths = buildSellPaths(token);

  for (const buyPath of buyPaths) {
    const buyOut = await quote(
      buy,
      TRADE_AMOUNT,
      buyPath
    );

    if (!buyOut) continue;

    for (const sellPath of sellPaths) {
      const sellOut = await quote(
        sell,
        buyOut,
        sellPath
      );

      if (!sellOut) continue;

      const profit =
        sellOut - TRADE_AMOUNT;

      if (profit < MIN_PROFIT) continue;

      console.log(
        `PROFIT FOUND ${fmt(profit)} USDC`
      );

      return {
        buy,
        sell,
        token,
        amountIn: TRADE_AMOUNT,
        buyPath,
        sellPath,
        expectedProfit: profit
      };
    }
  }

  return null;
}

/* ================= EXECUTE (fixed) ================= */

async function executeBatch(trades) {
  if (!trades.length) return;

  console.log("BATCH THRESHOLD REACHED");
  console.log(`EXECUTING ${trades.length} TRADES`);

  const batch = {
    buyRouters: trades.map((t) => t.buy),
    sellRouters: trades.map((t) => t.sell),
    amountsInUSDC: trades.map((t) => t.amountIn),
    pathsToToken: trades.map((t) => t.buyPath),
    pathsToUSDC: trades.map((t) => t.sellPath),
    deadline: Math.floor(Date.now() / 1000) + 60
  };

  // Balance before (so you can see change)
  const beforeBal = await safeRpc(() =>
    usdc.balanceOf(CONTRACT_ADDRESS)
  );

  console.log(`VAULT BEFORE ${fmt(beforeBal)} USDC`);

  // ---- FIX #1: timeout sendTx so we always reach "TX ... 0x..." ----
  const tx = await safeRpc(() =>
    withTimeout(
      vault.executeFlashBatchArbitrage(batch),
      SEND_TX_TIMEOUT_MS,
      "sendTx"
    )
  );

  // ---- FIX: tx hash prints immediately ----
  console.log(`TX ${tx.hash}`);
  console.log("SENT. CONFIRMING IN BACKGROUND...");

  // ---- FIX #2: confirmation + vault balance check in background ----
  (async () => {
    try {
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("TX WAIT TIMEOUT")),
            TX_WAIT_TIMEOUT_MS
          )
        )
      ]);

      console.log(`TX MINED. STATUS: ${receipt.status}`);
    } catch (e) {
      console.log(`TX CONFIRM FAILED (background): ${e?.message || e}`);
    }

    try {
      const afterBal = await safeRpc(() =>
        usdc.balanceOf(CONTRACT_ADDRESS)
      );
      console.log(`VAULT AFTER ${fmt(afterBal)} USDC`);
    } catch (e) {
      console.log(
        `BALANCE CHECK FAILED (background): ${e?.message || e}`
      );
    }
  })();

  // reset state immediately so bot keeps running
  microTrades = [];
  runningProfit = 0n;
}

/* ================= TASKS ================= */

function buildTasks() {
  const tasks = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;

      for (const token of Object.values(TOKENS)) {
        tasks.push({ buy, sell, token });
      }
    }
  }

  return tasks;
}

/* ================= LOOP ================= */

async function scanLoop() {
  while (true) {
    console.log("\nNEW SCAN");

    const tasks = buildTasks();
    let index = 0;

    async function worker() {
      while (index < tasks.length) {
        if (isExecuting) {
          await sleep(100);
          continue;
        }

        const task = tasks[index++];
        if (!task) break;

        const trade = await findTrade(
          task.buy,
          task.sell,
          task.token
        );

        if (!trade) continue;

        microTrades.push(trade);
        runningProfit += trade.expectedProfit;

        console.log(`MICRO TOTAL ${microTrades.length}`);
        console.log(`RUNNING TOTAL ${fmt(runningProfit)}`);

        if (runningProfit >= MIN_BATCH_PROFIT && !isExecuting) {
          isExecuting = true;

          try {
            await executeBatch([...microTrades]);
          } finally {
            isExecuting = false;
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: WORKER_COUNT }, worker)
    );

    await sleep(500);
  }
}

/* ================= MAIN ================= */

(async function main() {
  await initProvider();
  await scanLoop();
})();
