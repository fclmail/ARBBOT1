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
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = 0.03;
const MIN_EXPECTED_PROFIT = 0.000001;
const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;
const MAX_BATCH_SIZE = 3;

/* 🟢 Optimization Controls */
const MAX_LIQUIDITY_PERCENT = 0.00015; // 0.5% pool
const OPTIMIZATION_STEPS = 1;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

const vaultAbi = [
  {
    name: "executeFlashBatchArbitrage",
    type: "function",
    inputs: [
      { name: "buyRouters", type: "address[]" },
      { name: "sellRouters", type: "address[]" },
      { name: "amountsInUSDC", type: "uint256[]" },
      { name: "pathsToToken", type: "address[][]" },
      { name: "pathsToUSDC", type: "address[][]" },
      { name: "deadline", type: "uint256" }
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
  "function factory() view returns (address)"
];

const factoryAbi = [
  "function getPair(address tokenA, address tokenB) view returns (address)"
];

const pairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns (address)"
];

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

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeError(err) {
  return err?.reason || err?.message || "Unknown error";
}

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* 🟢 LIVE LIQUIDITY */
async function getLiquidity(routerAddr, tokenA, tokenB) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const factoryAddr = await router.factory();
    const factory = new ethers.Contract(factoryAddr, factoryAbi, provider);
    const pairAddr = await factory.getPair(tokenA, tokenB);
    if (pairAddr === ethers.ZeroAddress) return null;

    const pair = new ethers.Contract(pairAddr, pairAbi, provider);
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();

    return token0.toLowerCase() === tokenA.toLowerCase()
      ? r0
      : r1;
  } catch {
    return null;
  }
}

/* 🟢 PROFIT-FIRST + FULL HOP PATHS + OPTIMIZE */
async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {
  const usdc = TOKENS.USDC;
  const smallAmount = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let smallProfitDetected = false;

  const buyPaths = [
    [usdc, tokenAddr],
    [usdc, TOKENS.WMATIC, tokenAddr],
    [usdc, TOKENS.WETH, tokenAddr],
    [usdc, TOKENS.USDT, tokenAddr],
    [usdc, TOKENS.DAI, tokenAddr]
  ];

  const sellPaths = [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ];

  for (const buyPath of buyPaths) {
    const smallBuyOut = await quote(buyRouter, smallAmount, buyPath);
    if (!smallBuyOut) continue;

    for (const sellPath of sellPaths) {
      const smallSellOut = await quote(sellRouter, smallBuyOut, sellPath);
      if (!smallSellOut) continue;

      const smallProfit =
        Number(ethers.formatUnits(smallSellOut, 6)) - MIN_TRADE_USDC;

      if (smallProfit >= MIN_EXPECTED_PROFIT) {
        smallProfitDetected = true;
        console.log(`${CYAN}Small profit detected. Optimizing size...${RESET}`);

        const liquidity = await getLiquidity(buyRouter, usdc, tokenAddr);
        if (!liquidity) return null;

        const maxSize =
          Number(ethers.formatUnits(liquidity, 6)) *
          MAX_LIQUIDITY_PERCENT;

        let bestProfit = 0;
        let bestAmount = smallAmount;

        for (let i = 1; i <= OPTIMIZATION_STEPS; i++) {
          const size = (maxSize / OPTIMIZATION_STEPS) * i;
          if (size <= MIN_TRADE_USDC) continue;

          const amountIn = ethers.parseUnits(size.toFixed(6), 6);

          const buyOut = await quote(buyRouter, amountIn, buyPath);
          if (!buyOut) continue;

          const sellOut = await quote(sellRouter, buyOut, sellPath);
          if (!sellOut) continue;

          const profit =
            Number(ethers.formatUnits(sellOut, 6)) - size;

          if (profit > bestProfit) {
            bestProfit = profit;
            bestAmount = amountIn;
          }
        }

        if (bestProfit >= MIN_EXPECTED_PROFIT) {
          console.log(
            `${GREEN}PROFIT FOUND:${RESET} Gross: ${bestProfit.toFixed(2)} USDC`
          );

          return {
            buyRouter,
            sellRouter,
            amountIn: bestAmount,
            bestBuyPath: buyPath,
            bestSellPath: sellPath
          };
        }
      }
    }
  }

  return null;
}

/* ================= BATCH ================= */
async function batchArb() {
  const profitableTrades = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;
      for (const token of Object.values(TOKENS)) {
        const trade = await findProfitableTrade(buy, sell, token);
        if (trade) profitableTrades.push(trade);
        if (profitableTrades.length === MAX_BATCH_SIZE) break;
      }
      if (profitableTrades.length === MAX_BATCH_SIZE) break;
    }
    if (profitableTrades.length === MAX_BATCH_SIZE) break;
  }

  if (!profitableTrades.length)
    return console.log("No profitable trades");

  console.log(
    `${YELLOW}Collected ${profitableTrades.length} profitable trades${RESET}`
  );

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {
    const tx =
      await vault.executeFlashBatchArbitrage(
        profitableTrades.map((t) => t.buyRouter),
        profitableTrades.map((t) => t.sellRouter),
        profitableTrades.map((t) => t.amountIn),
        profitableTrades.map((t) => t.bestBuyPath),
        profitableTrades.map((t) => t.bestSellPath),
        deadline
      );

    console.log(`${GREEN}Batch flash sent:${RESET} ${tx.hash}`);
    await tx.wait();
    console.log(`${GREEN}Batch confirmed — profits deposited${RESET}`);
  } catch (err) {
    console.log(`${RED}Batch failed:${RESET}`, decodeError(err));
  }
}

/* ================= MAIN ================= */
async function main() {
  console.log("Run node scripts/arbitrage.js\n");
  while (true) {
    await batchArb();
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
