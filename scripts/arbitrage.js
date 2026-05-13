import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   ENV
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

/* =========================================================
   RPC
========================================================= */

const RPCS = [
  "https://polygon-bor-rpc.publicnode.com"
];

let rpcIndex = 0;

const provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

/* =========================================================
   ABI
========================================================= */

const arbAbi = [
  "function owner() view returns(address)",
  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",
  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const arb = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const USDC = TOKENS.USDC;

/* =========================================================
   SETTINGS
========================================================= */

const LOOP_DELAY = 5;
const WORKERS = 10;

let EXECUTING = false;

/* =========================================================
   HELPERS
========================================================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fmt = (x) =>
  Number(ethers.formatUnits(x, 6)).toFixed(6);

/* =========================================================
   DEPTH MODEL (FIXED SCALING)
========================================================= */

function computeRequiredProfit(size) {

  const flashFee = (size * 9n) / 10000n;

  // FIX: previously massively inflated (150 USDC → 15 USDC)
  const gasEstimate = 15n * 10n ** 6n;

  // FIX: reduced slippage pressure
  const slippageRisk = size / 20000n;

  const safetyMultiplier = 120n;

  return (flashFee + gasEstimate + slippageRisk) * safetyMultiplier;
}

/* =========================================================
   SIZE GRID
========================================================= */

function buildDepthSizes() {
  return [
    10000n * 10n ** 6n,
    50000n * 10n ** 6n,
    100000n * 10n ** 6n,
    500000n * 10n ** 6n,
    1000000n * 10n ** 6n,
    2000000n * 10n ** 6n,
    5000000n * 10n ** 6n
  ];
}

/* =========================================================
   BALANCES
========================================================= */

async function getVaultBalance() {
  const usdc = new ethers.Contract(USDC, erc20Abi, provider);
  return await usdc.balanceOf(CONTRACT_ADDRESS);
}

async function getMaticBalance() {
  return await provider.getBalance(CONTRACT_ADDRESS);
}

/* =========================================================
   STATIC SIMULATION
========================================================= */

async function staticCheck(spread, size) {

  const sim =
    await arb.simulateArbitrageProfit(
      spread.buy,
      spread.sell,
      size,
      spread.buyPath,
      spread.sellPath
    );

  return sim[1];
}

/* =========================================================
   SPREAD (simplified placeholder)
========================================================= */

async function detectSpread() {
  return {
    buy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    sell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    buyPath: [USDC, TOKENS.WETH],
    sellPath: [TOKENS.WETH, USDC]
  };
}

/* =========================================================
   DEPTH ANALYSIS (FIXED)
========================================================= */

async function runDepthAnalysis(tokenName) {

  console.log(`\n🔎 SCANNING: ${tokenName}`);

  const spread = await detectSpread();

  const sizes = buildDepthSizes();

  let best = null;
  let peak = 0n;
  let last = 0n;
  let liquidityWall = null;

  for (const size of sizes) {

    const [finalUSDC, profit] =
      await arb.simulateArbitrageProfit(
        spread.buy,
        spread.sell,
        size,
        spread.buyPath,
        spread.sellPath
      );

    const required = computeRequiredProfit(size);

    const slope =
      last > 0n
        ? Number(profit - last) / Number(size)
        : 0;

    last = profit;

    console.log(
      `SIZE ${fmt(size)} | PROFIT ${fmt(profit)} | REQUIRED ${fmt(required)}`
    );

    /* ❌ DEAD CURVE STOP */
    if (profit === 0n && size >= 1000000n * 10n ** 6n) {
      console.log("🛑 CURVE COLLAPSED");
      break;
    }

    /* ⚠️ LIQUIDITY WALL */
    if (!liquidityWall && profit < required) {
      liquidityWall = size;
    }

    /* 📉 COLLAPSE DETECTION */
    if (peak > 0n && profit < (peak * 70n) / 100n) {
      console.log("⚠️ LIQUIDITY COLLAPSE DETECTED");
      break;
    }

    /* 🏆 BEST PROFIT TRACKING */
    if (profit > peak) {
      peak = profit;

      best = {
        amountIn: size,
        estimatedFinalUSDC: finalUSDC,
        estimatedProfit: profit,
        slippageSlope: slope,
        liquidityWall
      };
    }
  }

  /* ❌ NULL GUARD FIX */
  if (!best) {
    console.log("\n❌ NO VALID DEPTH FOUND");
    return null;
  }

  console.log("\n🏆 LARGEST PROFIT BEFORE COLLAPSE");
  console.log(`SIZE: ${fmt(best.amountIn)}`);
  console.log(`PROFIT: ${fmt(best.estimatedProfit)}`);

  console.log("\n📊 DEPTH METRICS");
  console.log(`SLIPPAGE SLOPE: ${best.slippageSlope}`);
  console.log(`LIQUIDITY WALL: ${best.liquidityWall || "NONE"}`);

  /* STATIC CHECK */
  console.log("\n🧪 STATIC SIMULATION");

  const staticProfit =
    await staticCheck(spread, best.amountIn);

  if (staticProfit < best.estimatedProfit / 2n) {
    console.log("❌ STATIC FAILED");
    return null;
  }

  console.log("✅ STATIC PASSED");

  return {
    token: tokenName,
    route: spread,
    size: best.amountIn,
    profit: best.estimatedProfit
  };
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(signal) {

  console.log("\n🚀 EXECUTING FLASH LOAN");

  const before = await getVaultBalance();
  const matic = await getMaticBalance();

  console.log(`\n🏦 CONTRACT USDC: ${fmt(before)}`);
  console.log(`⛽ CONTRACT MATIC: ${ethers.formatEther(matic)}`);

  const tx =
    await arb.executeBestFlashLoanArbitrage(
      signal.route.buy,
      signal.route.sell,
      [signal.size],
      signal.route.buyPath,
      signal.route.sellPath,
      Math.floor(Date.now() / 1000) + 120
    );

  console.log(`\n📡 TX: ${tx.hash}`);

  const receipt = await tx.wait();

  const after = await getVaultBalance();

  console.log(`\n✅ BLOCK: ${receipt.blockNumber}`);
  console.log(`💰 BEFORE: ${fmt(before)}`);
  console.log(`💰 AFTER: ${fmt(after)}`);
  console.log(`📈 NET: ${fmt(after - before)}`);
}

/* =========================================================
   MAIN
========================================================= */

async function main() {

  console.log("\n🚀 INSTITUTIONAL LIQUIDITY ENGINE STARTED");

  const owner = await arb.owner();

  console.log(`\n👤 OWNER: ${owner}`);
  console.log(`👤 WALLET: ${wallet.address}`);

  const bal = await getVaultBalance();
  const matic = await getMaticBalance();

  console.log(`\n🏦 USDC: ${fmt(bal)}`);
  console.log(`⛽ MATIC: ${ethers.formatEther(matic)}`);

  const tokens = Object.keys(TOKENS).filter(t => t !== "USDC");

  let i = 0;

  async function worker() {

    while (true) {

      if (EXECUTING) {
        await sleep(1);
        continue;
      }

      const token = tokens[i++ % tokens.length];

      const signal = await runDepthAnalysis(token);

      if (!signal) {
        await sleep(LOOP_DELAY);
        continue;
      }

      console.log("\n🏆 BEST SIGNAL");
      console.log(`TOKEN: ${signal.token}`);
      console.log(`PROFIT: ${fmt(signal.profit)}`);
      console.log(`SIZE: ${fmt(signal.size)}`);

      EXECUTING = true;

      try {
        await execute(signal);
      } finally {
        EXECUTING = false;
      }

      await sleep(LOOP_DELAY);
    }
  }

  await Promise.all(
    Array.from({ length: WORKERS }, worker)
  );
}

main().catch(console.error);
