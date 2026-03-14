import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();
const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = 0.01;
const MIN_EXPECTED_PROFIT = 0.000001;
const TARGET_BATCH_SIZE = 2; // partial execution batch size
const WORKERS = 16;
const DEADLINE_SECONDS = 6000;
const SCAN_INTERVAL_MS = 5000;

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0x6dED2f1A44Ac58201510ddd56677ecb864Af5467";
const vaultAbi = [
  "function executeFlashBatchArbitrage(address[],address[],uint256[],address[][],address[][],uint256)",
  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};
const routerAbi = ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"];

/* ================= BUFFER ================= */
let tradeBuffer = [];

/* ================= HELPERS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function quote(routerAddr, amount, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amount, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= FIND TRADE ================= */
async function findProfitableTrade(buyRouter, sellRouter, token) {
  if (token === TOKENS.USDC) return null;
  if (buyRouter === sellRouter) return null;

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyPaths = [
    [TOKENS.USDC, token],
    [TOKENS.USDC, TOKENS.WMATIC, token],
    [TOKENS.USDC, TOKENS.WETH, token],
    [TOKENS.USDC, TOKENS.USDT, token],
    [TOKENS.USDC, TOKENS.DAI, token]
  ];

  let bestOut, bestBuyPath;

  for (const p of buyPaths) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestOut || out > bestOut)) {
      bestOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestOut) return null;

  const sellPaths = [
    [token, TOKENS.USDC],
    [token, TOKENS.WMATIC, TOKENS.USDC],
    [token, TOKENS.WETH, TOKENS.USDC],
    [token, TOKENS.USDT, TOKENS.USDC],
    [token, TOKENS.DAI, TOKENS.USDC]
  ];

  let bestSell, bestSellPath;

  for (const p of sellPaths) {
    const out = await quote(sellRouter, bestOut, p);
    if (out && (!bestSell || out > bestSell)) {
      bestSell = out;
      bestSellPath = p;
    }
  }

  if (!bestSell) return null;

  const profit = Number(ethers.formatUnits(bestSell, 6)) - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return null;

  return { buyRouter, sellRouter, amountIn, bestBuyPath, bestSellPath, profit };
}

/* ================= PARALLEL SCAN ================= */
async function parallelScan() {
  console.log("\nLaunching parallel scanners...");
  console.log("Workers started:", WORKERS);

  const tasks = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;

      for (const token of Object.values(TOKENS)) {
        tasks.push({ buy, sell, token });
      }
    }
  }

  let index = 0;
  const profitable = [];

  async function worker() {
    while (index < tasks.length) {
      const t = tasks[index++];
      const trade = await findProfitableTrade(t.buy, t.sell, t.token);
      if (trade) profitable.push(trade);
    }
  }

  const workers = [];
  for (let i = 0; i < WORKERS; i++) workers.push(worker());

  await Promise.all(workers);

  console.log(`Parallel scan finished, found ${profitable.length} trades`);
  return profitable;
}

/* ================= EXECUTE BATCH ================= */
async function executeBatch(trades) {
  console.log(`\nCollected trades: ${trades.length}`);

  const expanded = trades.slice(0, TARGET_BATCH_SIZE);

  console.log(`Compressed: ${expanded.length}`);
  console.log("Preparing batch...\n");

  const buyRouters = expanded.map(t => t.buyRouter);
  const sellRouters = expanded.map(t => t.sellRouter);
  const amounts = expanded.map(t => t.amountIn);
  const pathsA = expanded.map(t => t.bestBuyPath);
  const pathsB = expanded.map(t => t.bestSellPath);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log("Batch payload:");
  console.log({
    buyRouters,
    sellRouters,
    amounts: amounts.map(a => a.toString()),
    pathsA,
    pathsB,
    deadline
  });

  /* ================= DEBUG SIMULATION ================= */

  console.log("\nRunning staticCall simulation...");

  try {

    await vault.executeFlashBatchArbitrage.staticCall(
      buyRouters,
      sellRouters,
      amounts,
      pathsA,
      pathsB,
      deadline
    );

    console.log("Simulation SUCCESS — sending transaction\n");

  } catch (err) {

    console.log("\n=== SIMULATION FAILED ===");

    console.log("Short message:");
    console.log(err.shortMessage);

    console.log("\nFull error:");
    console.dir(err, { depth: null });

    if (err.reason) console.log("\nRevert reason:", err.reason);

    if (err.error?.message)
      console.log("\nRPC error:", err.error.message);

    console.log("\nBatch aborted.\n");

    return;
  }

  /* ================= SEND TX ================= */

  try {

    const tx = await vault.executeFlashBatchArbitrage(
      buyRouters,
      sellRouters,
      amounts,
      pathsA,
      pathsB,
      deadline
    );

    console.log("Transaction sent:", tx.hash);

    const receipt = await tx.wait();

    console.log("Transaction confirmed");
    console.log("Gas used:", receipt.gasUsed.toString());

    let executed = 0;
    let failed = 0;
    let profit = 0;

    for (const log of receipt.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed.name === "ArbitrageExecuted") {
          executed++;
          const p = Number(parsed.args[6]) / 1e6;
          if (p <= 0) failed++;
          else profit += p;
        }
      } catch {}
    }

    console.log(`Swaps executed: ${executed}`);
    console.log(`Swaps failed: ${failed}`);
    console.log(`Total profit: ${profit.toFixed(3)} USDC`);

  } catch (err) {
    console.error("Transaction failed:", err);
  }
}

/* ================= MAIN LOOP ================= */
async function main() {
  console.log("MEV Batch Scanner Started");

  while (true) {
    const newTrades = await parallelScan();

    if (newTrades.length > 0) {
      tradeBuffer.push(...newTrades);
      console.log("Buffered trades:", tradeBuffer.length);
    }

    if (tradeBuffer.length >= TARGET_BATCH_SIZE) {
      const batch = tradeBuffer.splice(0, TARGET_BATCH_SIZE);
      await executeBatch(batch);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
