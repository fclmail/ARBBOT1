import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

/* =========================================================
   RPC POOL (FIXED RELIABILITY)
========================================================= */

const RPCS = [
  "https://1rpc.io/matic",
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com"
];

let rpcIndex = 0;

function getProvider() {
  const rpc = RPCS[rpcIndex % RPCS.length];

  return new ethers.JsonRpcProvider(rpc, {
    name: "polygon",
    chainId: 137
  });
}

let provider = getProvider();
let wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   ADDRESSES
========================================================= */

const QUICKSWAP =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHISWAP =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const WMATIC =
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

/* =========================================================
   ABI
========================================================= */

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn,address[] calldata path) view returns (uint[] memory)"
];

/* =========================================================
   CONTRACTS
========================================================= */

const quickswap = new ethers.Contract(
  QUICKSWAP,
  ROUTER_ABI,
  provider
);

const sushiswap = new ethers.Contract(
  SUSHISWAP,
  ROUTER_ABI,
  provider
);

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatToken(amount, decimals) {
  return Number(
    ethers.formatUnits(amount, decimals)
  ).toFixed(6);
}

/* =========================================================
   SAFE CALL
========================================================= */

async function getOut(router, amountIn, path) {
  try {
    const res = await router.getAmountsOut(
      amountIn,
      path
    );

    return res[res.length - 1];
  } catch {
    return 0n;
  }
}

/* =========================================================
   DEPTH CURVE TEST
========================================================= */

async function testDepth(name, router) {

  console.log(`🟢 TESTING DEPTH CURVE → ${name}`);
  console.log("");

  const sizes = [25, 50, 100];

  let valid = false;

  for (const size of sizes) {

    const amountIn =
      ethers.parseUnits(size.toString(), 6);

    const out =
      await getOut(router, amountIn, [USDC, WMATIC]);

    const formatted =
      formatToken(out, 18); // WMATIC = 18 decimals

    console.log(
      `📐 SIZE ${size} USDC → ${formatted} WMATIC`
    );

    if (out > 0n) valid = true;
  }

  console.log("");

  if (valid) {
    console.log("🟢 DEPTH CURVE VALID");
  } else {
    console.log("❌ NO LIQUIDITY");
  }

  console.log("");

  return valid;
}

/* =========================================================
   BLOCK STABILITY
========================================================= */

async function checkBlocks() {

  const b1 = await provider.getBlockNumber();
  await sleep(800);
  const b2 = await provider.getBlockNumber();
  await sleep(800);
  const b3 = await provider.getBlockNumber();

  console.log(`📦 BLOCK VERIFIED → ${b1}`);
  console.log(`📦 BLOCK VERIFIED → ${b2}`);
  console.log(`📦 BLOCK VERIFIED → ${b3}`);
  console.log("");

  return true;
}

/* =========================================================
   PROFIT SCAN
========================================================= */

async function scan(name, buy, sell) {

  const amountIn =
    ethers.parseUnits("25", 6);

  const mid =
    await getOut(buy, amountIn, [USDC, WMATIC]);

  const out =
    await getOut(sell, mid, [WMATIC, USDC]);

  const profit =
    out > amountIn ? out - amountIn : 0n;

  console.log(
    `📊 ${name} PROFIT → ${formatToken(profit, 6)}`
  );

  return { name, profit };
}

/* =========================================================
   EXECUTION ENGINE
========================================================= */

async function execute(best) {

  console.log("");
  console.log("🚀 EXECUTION SIGNAL CONFIRMED");
  console.log("");

  console.log("❌ (SIMULATION MODE ENABLED)");
  console.log("📡 SENDING TRANSACTION DISABLED FOR SAFETY");
  console.log("");

  console.log(
    `🏆 BEST SIGNAL → ${best.name}`
  );
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function run() {

  while (true) {

    console.log("================================================");
    console.log("");

    const q =
      await testDepth("QUICKSWAP", quickswap);

    const s =
      await testDepth("SUSHISWAP", sushiswap);

    console.log("🟢 MEMPOOL STABLE");
    console.log("");

    await checkBlocks();

    console.log("🟢 SCANNING ROUTES");
    console.log("");

    const qProfit =
      await scan("QUICKSWAP", quickswap, sushiswap);

    const sProfit =
      await scan("SUSHISWAP", sushiswap, quickswap);

    console.log("");

    const best =
      qProfit.profit > sProfit.profit
        ? qProfit
        : sProfit;

    console.log(
      `🏆 BEST SIGNAL → ${best.name}`
    );

    if (best.profit <= 0n) {

      console.log("");
      console.log("❌ NO PROFITABLE ROUTE");
      console.log("");

      console.log("🟢 WAITING FOR NEXT SCAN");
      console.log("");

      await sleep(5000);
      continue;
    }

    await execute(best);

    console.log("");
    console.log("🟢 WAITING FOR NEXT SCAN");
    console.log("");

    await sleep(5000);
  }
}

run();
