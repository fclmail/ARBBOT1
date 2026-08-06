import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   ENV
========================================================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

/* =========================================================
   RPC
========================================================= */
const RPCS = [
  "https://polygon-bor-rpc.publicnode.com"
];

let rpcIndex = 0;

function nextProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url);
}

let provider = nextProvider();
let wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   CONFIG
========================================================= */
const BASE_TRADE       = ethers.parseUnits("5", 6);      // 5 USDC
const MIN_PROFIT       = ethers.parseUnits("0.05", 6);   // 5 cents
const GAS_COST_USDC   = ethers.parseUnits("0.01", 6);   // 1 cent
const BATCH_SIZE      = 2;
const LOOP_DELAY_MS   = 3000;
const CACHE_TTL_MS    = 1500;

/* =========================================================
   ADDRESSES
========================================================= */
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC             = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const TOKENS = {
  WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  LINK:   "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn:      "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* =========================================================
   ABIs
========================================================= */
const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

const vaultAbi = [
  "function executeVaultBatchArbitrage((address[] routers,uint256[] amountsInUSDC,address[][] paths,uint256 deadline) batch) external"
];

/* =========================================================
   CONTRACT INSTANCES
========================================================= */
let usdc = new ethers.Contract(USDC, erc20Abi, provider);
let vault = new ethers.Contract(CONTRACT_ADDRESS, vaultAbi, wallet);

let routerContracts = Object.fromEntries(
  Object.values(ROUTERS).map(addr => [
    addr,
    new ethers.Contract(addr, routerAbi, provider)
  ])
);

/* =========================================================
   HELPERS
========================================================= */
const fmt = (x) => ethers.formatUnits(x, 6);

function rebuildConnections() {
  provider = nextProvider();
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(USDC, erc20Abi, provider);
  vault = new ethers.Contract(CONTRACT_ADDRESS, vaultAbi, wallet);

  routerContracts = Object.fromEntries(
    Object.values(ROUTERS).map(addr => [
      addr,
      new ethers.Contract(addr, routerAbi, provider)
    ])
  );
}

const quoteCache = new Map();

function cacheKey(router, amount, path) {
  return `${router}-${amount.toString()}-${path.join("-")}`;
}

async function quote(router, amount, path) {
  const key = cacheKey(router, amount, path);
  const cached = quoteCache.get(key);

  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const amounts = await routerContracts[router].getAmountsOut(amount, path);
    const result = amounts[amounts.length - 1];

    quoteCache.set(key, { value: result, time: Date.now() });
    return result;
  } catch {
    quoteCache.set(key, { value: null, time: Date.now() });
    return null;
  }
}

function symbol(addr) {
  if (addr === USDC) return "USDC";
  return Object.keys(TOKENS).find(k => TOKENS[k] === addr) || addr.slice(0, 6);
}

function routeToString(path) {
  return path.map(symbol).join("->");
}

/* =========================================================
   BUILD TRIANGULAR PATHS
========================================================= */
function buildPaths() {
  return [
    [USDC, TOKENS.WETH,   TOKENS.DAI,  USDC],
    [USDC, TOKENS.WMATIC, TOKENS.LINK, USDC],
    [USDC, TOKENS.WETH,   TOKENS.USDT, USDC],
    [USDC, TOKENS.WMATIC, TOKENS.DAI,  USDC],
    [USDC, TOKENS.WBTC,   TOKENS.WETH, USDC]
  ];
}

/* =========================================================
   VERIFY REAL CYCLE PROFIT
========================================================= */
async function verifyCycle(router, path) {
  const finalAmount = await quote(router, BASE_TRADE, path);
  if (!finalAmount) return null;

  const profit = finalAmount - BASE_TRADE;

  // Require profit to exceed gas estimate
  if (profit < MIN_PROFIT + GAS_COST_USDC) return null;

  console.log(`🔔 VERIFIED | ${routeToString(path)} | ${fmt(profit)} USDC`);

  return {
    router,
    amountIn: BASE_TRADE,
    path,
    expectedProfit: profit
  };
}

/* =========================================================
   SCAN
========================================================= */
async function scan() {
  const paths = buildPaths();
  const routers = Object.values(ROUTERS);

  const promises = [];

  for (const router of routers) {
    for (const path of paths) {
      promises.push(verifyCycle(router, path));
    }
  }

  const results = await Promise.all(promises);

  return results
    .filter(Boolean)
    .sort((a, b) => Number(b.expectedProfit - a.expectedProfit))
    .slice(0, BATCH_SIZE);
}

/* =========================================================
   EXECUTION
========================================================= */
let cumulativeProfit = 0n;

async function executeBatch(trades) {
  console.log(`\\n🔥 EXECUTING BATCH`);

  const before = await usdc.balanceOf(CONTRACT_ADDRESS);

  const expected = trades.reduce((a, t) => a + t.expectedProfit, 0n);

  if (expected < GAS_COST_USDC * 2n) {
    console.log(`❌ SKIPPED | Expected ${fmt(expected)} USDC\\n`);
    return;
  }

  try {
    const tx = await vault.executeVaultBatchArbitrage({
      routers: trades.map(t => t.router),
      amountsInUSDC: trades.map(t => t.amountIn),
      paths: trades.map(t => t.path),
      deadline: Math.floor(Date.now() / 1000) + 60
    });

    const receipt = await tx.wait();

    const after = await usdc.balanceOf(CONTRACT_ADDRESS);
    const realProfit = after > before ? after - before : 0n;

    cumulativeProfit += realProfit;

    console.log(`📦 TX: ${receipt.hash}`);
    console.log(`💵 BATCH PROFIT: ${fmt(realProfit)} USDC`);
    console.log(`🏦 CONTRACT BALANCE: ${fmt(after)} USDC`);
    console.log(`📈 CUMULATIVE PROFIT: ${fmt(cumulativeProfit)} USDC\\n`);

  } catch (err) {
    console.log(`❌ EXECUTION FAILED: ${err.shortMessage || err.message}\\n`);
  }
}

/* =========================================================
   MAIN LOOP
========================================================= */
async function main() {
  console.log("🚀 BOT STARTED\\n");

  let lastBlock = 0;

  while (true) {
    try {
      const block = await provider.getBlockNumber();

      if (block !== lastBlock) {
        lastBlock = block;
        quoteCache.clear();
      }

      const trades = await scan();

      if (trades.length > 0) {
        await executeBatch(trades);
      }

      await new Promise(r => setTimeout(r, LOOP_DELAY_MS));

    } catch (err) {
      console.log(`⚠️ MAIN LOOP ERROR: ${err.message}`);
      rebuildConnections();
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch(console.error);
