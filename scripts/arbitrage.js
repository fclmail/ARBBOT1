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

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = 0.02; // micro scan amount
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

// Flash loan dynamic sizes (removed fixed sizes)
const FLASH_SIZES = [5, 10, 20, 30, 40, 50, 100, 200, 500, 1000];

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= FLASH CONTRACT ================= */

const FLASH_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const flashAbi = [
  {
    name: "executeFlashArbitrage",
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
  }
];

const flash = new ethers.Contract(FLASH_ADDRESS, flashAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
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

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= BINARY SEARCH FUNCTION ================= */

async function binarySearchFlashSize(buyRouter, sellRouter, bestBuyPath, bestSellPath, maxSize, minSize) {
  let low = minSize;
  let high = maxSize;
  let bestNetProfit = 0;
  let bestSize = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const flashAmount = ethers.parseUnits(mid.toString(), 6);

    // Get the buy amount
    const buyOut = await quote(buyRouter, flashAmount, bestBuyPath);
    if (!buyOut) {
      high = mid - 1;
      continue;
    }

    // Get the sell amount
    const sellOut = await quote(sellRouter, buyOut, bestSellPath);
    if (!sellOut) {
      high = mid - 1;
      continue;
    }

    const gross = Number(ethers.formatUnits(sellOut, 6)) - mid;

    const flashFee = mid * 0.0009; // Aave 0.09%
    const estimatedGas = 3; // adjust if needed

    const net = gross - flashFee - estimatedGas;

    console.log(`
[SIZE ${mid}]
Gross: ${gross.toFixed(4)}
Flash Fee: ${flashFee.toFixed(4)}
Gas: ${estimatedGas}
Net: ${net.toFixed(4)}
`);

    if (net > bestNetProfit) {
      bestNetProfit = net;
      bestSize = mid;
    }

    // Binary search: Adjust the low or high bounds
    if (net > 0) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return bestSize;
}

/* ================= ARBITRAGE ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = TOKENS.USDC;
  const microAmount = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  /* ========= STAGE 1: MICRO SCAN (UNCHANGED LOGIC) ========= */

  let bestBuyOut, bestBuyPath;

  for (const p of [
    [usdc, tokenAddr],
    [usdc, TOKENS.WMATIC, tokenAddr],
    [usdc, TOKENS.WETH, tokenAddr],
    [usdc, TOKENS.USDT, tokenAddr],
    [usdc, TOKENS.DAI, tokenAddr]
  ]) {
    const out = await quote(buyRouter, microAmount, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestBuyOut) return;

  let bestSellOut, bestSellPath;

  for (const p of [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ]) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }

  if (!bestSellOut) return;

  const microProfit =
    Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

  if (microProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`\nMICRO OPPORTUNITY FOUND: +${microProfit.toFixed(6)} USDC`);

  /* ========= STAGE 2: FLASH SCALING WITH BINARY SEARCH ========= */

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  // Apply binary search to find optimal flash size
  const bestSize = await binarySearchFlashSize(buyRouter, sellRouter, bestBuyPath, bestSellPath, 1000, 100);

  if (bestSize > 0) {
    const flashAmount = ethers.parseUnits(bestSize.toString(), 6);

    try {
      const tx = await flash.executeFlashArbitrage(
        buyRouter,
        sellRouter,
        flashAmount,
        bestBuyPath,
        bestSellPath,
        deadline
      );

      console.log(`FLASH EXECUTED: ${tx.hash}`);
    } catch (error) {
      console.error("Flash Loan Execution Failed:", error);
    }
  }
}

/* ================= MAIN ================= */

async function main() {
  while (true) {
    try {
      // Scan each router pair for arbitrage opportunities
      for (const [buyRouterName, buyRouterAddr] of Object.entries(routers)) {
        for (const [sellRouterName, sellRouterAddr] of Object.entries(routers)) {
          if (buyRouterAddr !== sellRouterAddr) {
            console.log(`Checking arbitrage: ${buyRouterName} -> ${sellRouterName}`);
            for (const tokenAddr of Object.values(TOKENS)) {
              await tryArb(buyRouterAddr, sellRouterAddr, tokenAddr);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error in main loop:", error);
    }

    // Wait for the next scan interval
    console.log(`Waiting for ${SCAN_INTERVAL_MS / 1000} seconds before next scan...`);
    await sleep(SCAN_INTERVAL_MS);
  }
}

/* ================= EXECUTION ================= */

main()
  .then(() => console.log("Arbitrage bot is running..."))
  .catch((err) => console.error("Error starting the bot:", err));
