import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PK");

/* ================= CONFIG ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const abi = [
  "function triggerFlashArbitrage((address,address,address) route,uint256,uint256) external"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const USDC = TOKENS.USDC;

/* ================= ROUTERS ================= */

const QUICK = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= STATE ================= */

let bestSignal = {
  profit: 0n,
  size: 0n,
  token: null,
  route: null
};

/* ================= HELPERS ================= */

const fmt = (x) => Number(ethers.formatUnits(x, 6)).toFixed(6);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const clamp = (x, min, max) =>
  x < min ? min : x > max ? max : x;

/* ================= ROUTE ================= */

function makeRoute(token) {
  return {
    buyRouter: QUICK,
    sellRouter: SUSHI,
    pathToToken: [USDC, token],
    pathToUSDC: [token, USDC]
  };
}

/* ================= VAULT BALANCE FIX ================= */

async function getVaultBalance() {
  return await new ethers.Contract(
    USDC,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  ).balanceOf(CONTRACT_ADDRESS);
}

/* ================= MICRO SCAN ================= */

async function scanToken(name, token) {
  try {
    const route = makeRoute(token);

    const vaultBal = await getVaultBalance();

    console.log(`\n🔎 SCANNING ${name}`);
    console.log(`💰 Vault: ${fmt(vaultBal)} USDC`);

    // simulated profit model (replace with real router call if needed)
    const baseProfit = BigInt(Math.floor(Math.random() * 5000));

    const efficiency = (baseProfit * 1_000_000n) / (vaultBal / 100n);

    console.log(`📊 Profit: ${fmt(baseProfit)}`);
    console.log(`⚡ Efficiency: ${efficiency}`);

    /* ================= CONTINUOUS SCALING ================= */

    let scale;

    if (efficiency > 3000n) scale = 60n;
    else if (efficiency > 1500n) scale = 30n;
    else if (efficiency > 800n) scale = 15n;
    else scale = 5n;

    const rawSize = (vaultBal * scale) / 100n;

    const size = clamp(
      rawSize,
      vaultBal / 100n,  // 1% min
      vaultBal / 2n     // 50% max
    );

    console.log(`📐 SCALE: ${scale / 100n}x`);
    console.log(`🚀 SIZE: ${fmt(size)} USDC`);

    return {
      token,
      route,
      profit: baseProfit,
      size
    };

  } catch (err) {
    console.log(`❌ Scan failed for ${name}: ${err.message}`);
    return null;
  }
}

/* ================= EXECUTION ================= */

async function execute(signal) {
  console.log(`\n🔥 EXECUTING TRADE`);

  const before = await getVaultBalance();

  const tx = await vault.triggerFlashArbitrage(
    {
      routerBuy: signal.route.buyRouter,
      routerSell: signal.route.sellRouter,
      token: signal.token
    },
    signal.size,
    1n
  );

  console.log(`TX: ${tx.hash}`);

  await tx.wait();

  const after = await getVaultBalance();

  const profit = after - before;

  console.log(`💰 BEFORE: ${fmt(before)}`);
  console.log(`💰 AFTER : ${fmt(after)}`);
  console.log(`📈 PROFIT: ${fmt(profit)}`);
}

/* ================= MAIN LOOP ================= */

async function main() {
  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED");

  while (true) {

    const results = await Promise.all(
      Object.entries(TOKENS)
        .filter(([k]) => k !== "USDC")
        .map(([name, token]) => scanToken(name, token))
    );

    const valid = results.filter(Boolean);

    const best = valid.reduce(
      (a, b) => (b.profit > a.profit ? b : a),
      { profit: 0n }
    );

    if (best.profit > 0n) {

      console.log(`\n🏆 BEST SIGNAL`);
      console.log(`TOKEN: ${best.token}`);
      console.log(`PROFIT: ${fmt(best.profit)}`);
      console.log(`SIZE: ${fmt(best.size)}`);

      bestSignal = best;

      // execution threshold (micro → macro gate)
      if (best.profit > 2000n) {
        await execute(best);
      }

    } else {
      console.log(`💤 No opportunity`);
    }

    await sleep(2000);
  }
}

main();
