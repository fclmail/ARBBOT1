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

const CONTRACT_ADDRESS = "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

/* ================= CONTRACT ================= */

const abi = [
  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns(tuple(uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",
  "function getContractUSDCBalance() view returns(uint256)",
  "function triggerFlashArbitrage((address,address,address) route,uint256,uint256) external"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

/* ================= ROUTERS ================= */

const QUICK = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

/* ================= STATE ================= */

let bestGlobal = {
  profit: 0n,
  size: 0n,
  token: null,
  route: null
};

/* ================= HELPERS ================= */

const fmt = (x) => Number(ethers.formatUnits(x, 6)).toFixed(6);

const clamp = (x, min, max) =>
  x < min ? min : x > max ? max : x;

/* ================= ROUTE ================= */

function makeRoute(token) {
  return {
    buyRouter: QUICK,
    sellRouter: SUSHI,
    pathToToken: [TOKENS.USDC, token],
    pathToUSDC: [token, TOKENS.USDC]
  };
}

/* ================= MICRO SCAN ================= */

async function scanToken(tokenName, token) {

  const route = makeRoute(token);

  const vaultBal = await vault.getContractUSDCBalance();

  console.log(`\n🔎 SCANNING ${tokenName}`);
  console.log(`💰 Vault: ${fmt(vaultBal)} USDC`);

  const result = await vault.findBestFlashLoanSize(
    route.buyRouter,
    route.sellRouter,
    [
      vaultBal / 100n,   // 1%
      vaultBal / 50n,    // 2%
      vaultBal / 20n,    // 5%
      vaultBal / 10n,    // 10%
      vaultBal / 4n      // 25%
    ],
    route.pathToToken,
    route.pathToUSDC
  );

  const profit = result.estimatedProfit;
  const amount = result.amountIn;

  if (profit === 0n) {
    console.log(`❌ No edge detected`);
    return null;
  }

  const efficiency = (profit * 1_000_000n) / amount;

  console.log(`📊 Profit: ${fmt(profit)}`);
  console.log(`⚡ Efficiency: ${efficiency}`);

  /* ================= CONTINUOUS SCALING ================= */

  let scaleFactor = 0n;

  if (efficiency > 3000n) scaleFactor = 60n; // macro
  else if (efficiency > 1500n) scaleFactor = 30n;
  else if (efficiency > 800n) scaleFactor = 15n;
  else scaleFactor = 5n;

  const scaledSize = (vaultBal * scaleFactor) / 100n;

  const finalSize = clamp(
    scaledSize,
    vaultBal / 100n,  // min 1%
    vaultBal / 2n     // max 50%
  );

  console.log(`📐 SCALE FACTOR: ${scaleFactor / 100n}x`);
  console.log(`🚀 FINAL SIZE: ${fmt(finalSize)} USDC`);

  return {
    token,
    route,
    profit,
    size: finalSize
  };
}

/* ================= EXECUTION ================= */

async function execute(best) {

  console.log(`\n🔥 EXECUTING TRADE`);

  const before = await vault.getContractUSDCBalance();

  const tx = await vault.triggerFlashArbitrage(
    {
      routerBuy: best.route.buyRouter,
      routerSell: best.route.sellRouter,
      token: best.token
    },
    best.size,
    1n
  );

  console.log(`TX: ${tx.hash}`);

  await tx.wait();

  const after = await vault.getContractUSDCBalance();

  const realProfit = after - before;

  console.log(`💰 BEFORE: ${fmt(before)}`);
  console.log(`💰 AFTER : ${fmt(after)}`);
  console.log(`📈 PROFIT: ${fmt(realProfit)}`);
}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED");

  while (true) {

    const candidates = await Promise.all(
      Object.entries(TOKENS)
        .filter(([k]) => k !== "USDC")
        .map(([name, token]) => scanToken(name, token))
    );

    const valid = candidates.filter(Boolean);

    const best = valid.reduce((a, b) =>
      b.profit > a.profit ? b : a,
      { profit: 0n }
    );

    if (best.profit > 0n) {

      console.log(`\n🏆 BEST SIGNAL`);
      console.log(`TOKEN: ${best.token}`);
      console.log(`PROFIT: ${fmt(best.profit)}`);
      console.log(`SIZE: ${fmt(best.size)}`);

      if (bestGlobal.profit < best.profit) {
        bestGlobal = best;
      }

      if (best.profit > 500000n) {
        await execute(best);
      }

    } else {
      console.log(`💤 No scalable opportunity`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

main();
