import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const RPC_POLYGON =
  (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();
const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = 0.020;
const TARGET_BATCH_SIZE = 2;
const SCAN_INTERVAL_MS = 400;
const DEADLINE_SECONDS = 60;
const NUM_WORKERS = 32;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= FACTORIES ================= */
const factories = {
  QuickSwap: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  SushiSwap: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
  ApeSwap: "0xcf083be4164828f00cae704ec15a36d711491284",
  Wault: "0xb6c8f9e5a7d62c3a7ef7fdf7b8e4c0e5efb1e77d"
};

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

/* ================= ABIS ================= */
const factoryAbi = ["function getPair(address,address) view returns(address)"];
const pairAbi = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)"
];

/* ================= VAULT ================= */
const VAULT_ADDRESS = "0xf7e8A1580Dd9b3757Fb6a1f86AD5ed0e0F3EfC31";
const vaultAbi = [{
  name: "executeFlashBatchArbitrage",
  type: "function",
  inputs: [
    { type: "address[]" },
    { type: "address[]" },
    { type: "uint256[]" },
    { type: "address[][]" },
    { type: "address[][]" },
    { type: "uint256" }
  ],
  outputs: []
}];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodeError(err) {
  return (
    err?.reason ||
    err?.shortMessage ||
    err?.info?.error?.message ||
    err?.message ||
    "Unknown error"
  );
}

/* ===== UNISWAP V2 MATH ===== */
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * 997;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000 + amountInWithFee;
  return Math.floor(numerator / denominator);
}

/* ================= RESERVE QUOTE ================= */
async function quotePath(factoryAddr, amountIn, path) {
  let amount = amountIn;
  const factory = new ethers.Contract(factoryAddr, factoryAbi, provider);

  for (let i = 0; i < path.length - 1; i++) {
    const tokenA = path[i];
    const tokenB = path[i + 1];

    if (tokenA.toLowerCase() === tokenB.toLowerCase()) return null;

    let pairAddr;
    try {
      pairAddr = await factory.getPair(tokenA, tokenB);
    } catch {
      return null;
    }

    if (!pairAddr || pairAddr === "0x0000000000000000000000000000000000000000") return null;

    const pair = new ethers.Contract(pairAddr, pairAbi, provider);

    let r0, r1;
    try {
      [r0, r1] = await pair.getReserves();
    } catch {
      return null;
    }

    const token0 = await pair.token0();
    let reserveIn, reserveOut;
    if (token0.toLowerCase() === tokenA.toLowerCase()) {
      reserveIn = Number(r0);
      reserveOut = Number(r1);
    } else {
      reserveIn = Number(r1);
      reserveOut = Number(r0);
    }

    amount = getAmountOut(amount, reserveIn, reserveOut);
  }

  return amount;
}

/* ================= FIND TRADE ================= */
async function findTrade(buyDex, sellDex, token) {
  if (token === TOKENS.USDC) return null;

  const amountIn = MIN_TRADE_USDC * 1e6;

  const intermediates = [TOKENS.WMATIC, TOKENS.WETH, TOKENS.USDT, TOKENS.DAI];
  const buyPaths = [[TOKENS.USDC, token]];
  const sellPaths = [[token, TOKENS.USDC]];

  for (const mid of intermediates) {
    if (mid !== token) {
      buyPaths.push([TOKENS.USDC, mid, token]);
      sellPaths.push([token, mid, TOKENS.USDC]);
    }
  }

  let bestBuy = 0, bestBuyPath = null;
  for (const p of buyPaths) {
    const out = await quotePath(factories[buyDex], amountIn, p);
    if (out && out > bestBuy) {
      bestBuy = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyPath) return null;

  let bestSell = 0, bestSellPath = null;
  for (const p of sellPaths) {
    const out = await quotePath(factories[sellDex], bestBuy, p);
    if (out && out > bestSell) {
      bestSell = out;
      bestSellPath = p;
    }
  }
  if (!bestSellPath) return null;

  const profit = (bestSell / 1e6) - MIN_TRADE_USDC;
  if (profit <= 0) return null;

  console.log(`${CYAN}Opportunity${RESET} ${buyDex} -> ${sellDex} | Profit: ${profit}`);

  return {
    buyRouter: routers[buyDex],
    sellRouter: routers[sellDex],
    amountIn: ethers.parseUnits(MIN_TRADE_USDC.toString(), 6),
    bestBuyPath,
    bestSellPath,
    profit
  };
}

/* ================= SCAN ================= */
async function scanWorker(tokensSubset) {
  const trades = [];
  for (const buy of Object.keys(routers)) {
    for (const sell of Object.keys(routers)) {
      if (buy === sell) continue;
      for (const token of tokensSubset) {
        const t = await findTrade(buy, sell, token);
        if (t) trades.push(t);
      }
    }
  }
  return trades;
}

async function scan() {
  const tokenValues = Object.values(TOKENS);
  const chunkSize = Math.ceil(tokenValues.length / NUM_WORKERS);
  const workerChunks = [];
  for (let i = 0; i < tokenValues.length; i += chunkSize) {
    workerChunks.push(tokenValues.slice(i, i + chunkSize));
  }

  const results = await Promise.all(workerChunks.map(scanWorker));
  return results.flat();
}

/* ================= EXECUTION (FIXED ethers v6 + BigInt) ================= */
async function executeBatch(trades) {
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const buyRouters = trades.map(t => t.buyRouter);
  const sellRouters = trades.map(t => t.sellRouter);
  const amounts = trades.map(t => t.amountIn);
  const p1 = trades.map(t => t.bestBuyPath);
  const p2 = trades.map(t => t.bestSellPath);

  try {
    console.log(`${CYAN}Simulating flash batch...${RESET}`);
    await vault.executeFlashBatchArbitrage.staticCall(
      buyRouters,
      sellRouters,
      amounts,
      p1,
      p2,
      deadline
    );
    console.log(`${GREEN}Simulation passed${RESET}`);

    const estimatedGas = await vault.executeFlashBatchArbitrage.estimateGas(
      buyRouters,
      sellRouters,
      amounts,
      p1,
      p2,
      deadline
    );

    const gasLimit = BigInt(estimatedGas) * 120n / 100n; // 20% buffer

    const tx = await vault.executeFlashBatchArbitrage(
      buyRouters,
      sellRouters,
      amounts,
      p1,
      p2,
      deadline,
      {
        gasLimit,
        maxPriorityFeePerGas: ethers.parseUnits("50", "gwei")
      }
    );

    console.log(`${GREEN}TX SENT${RESET}`, tx.hash);
    await tx.wait();
    console.log(`${GREEN}TX CONFIRMED${RESET}`);

  } catch (err) {
    console.log(`${RED}Batch failed:${RESET}`, decodeError(err));
  }
}

/* ================= LOOP (BATCHING FIX) ================= */
async function main() {
  console.log(`${GREEN}Reserve MEV Scanner Started${RESET}`);
  console.log(`${CYAN}Wallet:${RESET}`, wallet.address);

  while (true) {
    const allTrades = await scan();
    console.log(`${YELLOW}Trades collected:${RESET}`, allTrades.length);

    // Execute in batches of TARGET_BATCH_SIZE
    for (let i = 0; i < allTrades.length; i += TARGET_BATCH_SIZE) {
      const batch = allTrades.slice(i, i + TARGET_BATCH_SIZE);
      if (batch.length > 0) {
        await executeBatch(batch);
      }
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
