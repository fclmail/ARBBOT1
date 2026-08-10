import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ==========================================================================
   CONFIGURATIONS & PARAMETERS
   ========================================================================== */

const RPC_URL = process.env.RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("💥 [FATAL] Private key missing from environment variables.");
  process.exit(1);
}

const ARBITRAGE_CONTRACT_ADDRESS = process.env.ARBITRAGE_CONTRACT_ADDRESS || "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Adjustable Controls
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 3;
const TRADE_AMOUNT_USDC = process.env.TRADE_AMOUNT_USDC || "0.02";
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC || "0.0002";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 500;

/* ==========================================================================
   REGISTRY
   ========================================================================== */

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const TOKENS = {
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4F2C47D9BfD6",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ==========================================================================
   ABIs & CACHE
   ========================================================================== */

const USDC_ABI = [
  "function balanceOf(address account) external view returns (uint256)"
];

const ARBITRAGE_CONTRACT_ABI = [
  "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
  "function minimumProfitUSDC() external view returns (uint256)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)"
];

const fmt = (x) => ethers.formatUnits(x, 6);
const quoteCache = new Map();
const CACHE_TTL_MS = 1000;

function getCachedQuote(router, path) {
  const key = `${router}-${path.join("-")}`;
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.value;
  return undefined;
}

function setCachedQuote(router, path, value) {
  const key = `${router}-${path.join("-")}`;
  quoteCache.set(key, { value, timestamp: Date.now() });
}

/* ==========================================================================
   DYNAMIC MULTI-HOP PATH GENERATOR
   ========================================================================== */

function buildMultiHopPaths() {
  const tokens = Object.values(TOKENS);
  const paths = [];

  for (const a of tokens) {
    for (const b of tokens) {
      if (a === b) continue;
      // 3-step triangular (USDC -> A -> B -> USDC)
      paths.push([USDC_ADDRESS, a, b, USDC_ADDRESS]);

      for (const c of tokens) {
        if (a === c || b === c) continue;
        // 4-step multi-hop (USDC -> A -> B -> C -> USDC)
        paths.push([USDC_ADDRESS, a, b, c, USDC_ADDRESS]);
      }
    }
  }
  return paths;
}

const getSymbol = (addr) =>
  Object.keys(TOKENS).find((k) => TOKENS[k].toLowerCase() === addr.toLowerCase()) || addr.slice(0, 6);

/* ==========================================================================
   OFF-CHAIN QUOTING & OPPORTUNITY SCANNER
   ========================================================================== */

async function quote(routerContract, amount, path) {
  const cached = getCachedQuote(routerContract.target, path);
  if (cached !== undefined) return cached;

  try {
    const out = await routerContract.getAmountsOut(amount, path);
    const result = out[out.length - 1];
    setCachedQuote(routerContract.target, path, result);
    return result;
  } catch {
    setCachedQuote(routerContract.target, path, null);
    return null;
  }
}

async function findArbitrageOpportunity(routerContract, path, baseTradeUnits, minProfitUnits) {
  let currentAmount = baseTradeUnits;

  for (let i = 0; i < path.length - 1; i++) {
    const hopPath = [path[i], path[i + 1]];
    const nextOut = await quote(routerContract, currentAmount, hopPath);
    if (!nextOut) return null;
    currentAmount = nextOut;
  }

  const profit = currentAmount - baseTradeUnits;
  if (profit <= 0n || profit < minProfitUnits) return null;

  const routeDescription = path.map((addr) => getSymbol(addr)).join("->");
  console.log(`🔔 OPPORTUNITY FOUND | Route: ${routeDescription} | Profit: ${fmt(profit)} USDC`);

  return {
    router: routerContract.target,
    amountIn: baseTradeUnits,
    pathToToken: path.slice(0, path.length - 1),
    pathToUSDC: [path[path.length - 2], USDC_ADDRESS],
    expectedProfit: profit
  };
}

async function parallelScan(paths, routerContracts, baseTradeUnits, minProfitUnits) {
  const batchResults = [];
  const routersList = Object.values(routerContracts);

  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const pathChunk = paths.slice(i, i + BATCH_SIZE);
    const scanPromises = [];

    for (const routerContract of routersList) {
      for (const path of pathChunk) {
        scanPromises.push(
          findArbitrageOpportunity(routerContract, path, baseTradeUnits, minProfitUnits).catch(() => null)
        );
      }
    }

    const results = await Promise.all(scanPromises);
    const valid = results.filter((r) => r !== null);
    batchResults.push(...valid);

    if (batchResults.length >= BATCH_SIZE) break;
  }

  return batchResults.slice(0, BATCH_SIZE);
}

/* ==========================================================================
   EXECUTION ENGINE
   ========================================================================== */

export async function executeSafeBatchArbitrage(provider, signer, trades) {
  if (!trades || trades.length === 0) return null;

  const arbitrageContract = new ethers.Contract(ARBITRAGE_CONTRACT_ADDRESS, ARBITRAGE_CONTRACT_ABI, signer);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  const batchParams = {
    buyRouters: trades.map((t) => t.router),
    sellRouters: trades.map((t) => t.router),
    amountsInUSDC: trades.map((t) => t.amountIn),
    pathsToToken: trades.map((t) => t.pathToToken),
    pathsToUSDC: trades.map((t) => t.pathToUSDC),
    deadline: Math.floor(Date.now() / 1000) + 300
  };

  try {
    const contractAddress = await arbitrageContract.getAddress();
    const startingBalance = await usdcContract.balanceOf(contractAddress);

    // Off-chain pre-simulation
    await arbitrageContract.executeFlashBatchArbitrage.staticCall(batchParams);

    console.log(`\n=================== 📊 TRADE ATTEMPT 📊 ===================`);
    console.log(`📍 Contract Address : ${contractAddress}`);
    console.log(`💰 Starting Balance : 💵 ${fmt(startingBalance)} USDC`);
    console.log(`📦 Batch Trades     : ${trades.length} profitable routes`);
    console.log("✅ Simulation Passed! Executing transaction...");

    const estimatedGas = await arbitrageContract.executeFlashBatchArbitrage.estimateGas(batchParams);
    const safeGasLimit = (BigInt(estimatedGas) * 120n) / 100n;

    const tx = await arbitrageContract.executeFlashBatchArbitrage(batchParams, {
      gasLimit: safeGasLimit
    });

    console.log(`🔗 Tx Hash          : ${tx.hash}`);
    const receipt = await tx.wait();

    const endingBalance = await usdcContract.balanceOf(contractAddress);
    const netProfitUnits = BigInt(endingBalance) - BigInt(startingBalance);

    console.log(`\n=================== 📈 RESULTS 📈 ===================`);
    console.log(`🏦 Ending Balance   : 💵 ${fmt(endingBalance)} USDC`);
    console.log(`🚀 Net Realized     : 🤑 +${fmt(netProfitUnits)} USDC (Block #${receipt.blockNumber})`);
    console.log(`======================================================\n`);

    return receipt;
  } catch (error) {
    console.error("⚠️ BATCH EXECUTION FAILED/REVERTED:", error.message || error);
    return null;
  }
}

/* ==========================================================================
   CONTINUOUS SCANNER ENTRY POINT
   ========================================================================== */

async function startContinuousScanner() {
  console.log("🤖 =================================================== 🤖");
  console.log("🚀       ARBBOT1 CONTINUOUS SCANNER STARTED          🚀");
  console.log(`⚙️  Batch Size: ${BATCH_SIZE} | Base Trade: ${TRADE_AMOUNT_USDC} USDC | Min Profit: ${MIN_PROFIT_USDC} USDC`);
  console.log("🤖 =================================================== 🤖\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  const routerContracts = Object.fromEntries(
    Object.entries(ROUTERS).map(([name, address]) => [
      name,
      new ethers.Contract(address, ROUTER_ABI, provider)
    ])
  );

  const multiHopPaths = buildMultiHopPaths();
  const baseTradeUnits = ethers.parseUnits(TRADE_AMOUNT_USDC, 6);
  const minProfitUnits = ethers.parseUnits(MIN_PROFIT_USDC, 6);

  let scanCount = 0;
  let lastBlock = 0;

  while (true) {
    scanCount++;
    try {
      const currentBlock = await provider.getBlockNumber();

      if (currentBlock > lastBlock) {
        lastBlock = currentBlock;
        quoteCache.clear();
      }

      console.log(`🔍 [Scan #${scanCount}] Checking ${multiHopPaths.length} multi-hop routes on Block #${currentBlock}...`);

      const profitableTrades = await parallelScan(multiHopPaths, routerContracts, baseTradeUnits, minProfitUnits);

      if (profitableTrades.length > 0) {
        await executeSafeBatchArbitrage(provider, signer, profitableTrades);
      }
    } catch (err) {
      console.error(`❌ [Scan #${scanCount}] Error during loop cycle:`, err.message || err);
    }

    await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
  }
}

startContinuousScanner().catch((err) => {
  console.error("💥 [FATAL SCANNER ERROR]", err);
  process.exit(1);
});
