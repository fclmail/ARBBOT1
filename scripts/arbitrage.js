import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const PK = process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;
if (!PK) throw new Error("Missing PRIVATE_KEY");

/* ================= RPC ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PK, provider);

/* ================= CONTRACT ================= */

const CONTRACT = "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const abi = [
  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",
  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",
  "function minimumProfitUSDC() view returns(uint256)"
];

const vault = new ethers.Contract(CONTRACT, abi, wallet);

/* ================= ROUTERS ================= */

const QUICK = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  DAI:  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ================= CONFIG ================= */

const BASE_SIZES = [
  ethers.parseUnits("1000",6),
  ethers.parseUnits("5000",6),
  ethers.parseUnits("10000",6),
  ethers.parseUnits("25000",6),
  ethers.parseUnits("50000",6),
  ethers.parseUnits("100000",6)
];

const MIN_MICRO_PROFIT = ethers.parseUnits("0.00001",6);
const BATCH_TRIGGER = ethers.parseUnits("0.003",6);

/* ================= STATE ================= */

let microPool = [];
let runningProfit = 0n;
let executing = false;

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function route(token, inter = null) {
  return {
    buyRouter: QUICK,
    sellRouter: SUSHI,
    pathToToken: inter
      ? [TOKENS.USDC, inter, token]
      : [TOKENS.USDC, token],
    pathToUSDC: inter
      ? [token, inter, TOKENS.USDC]
      : [token, TOKENS.USDC],
    deadline: Math.floor(Date.now()/1000)+60
  };
}

/* ================= LIQUIDITY SCORING ================= */

function efficiency(profit, size) {
  if (size === 0n) return 0n;
  return (profit * 1000000n) / size;
}

/* ================= SIMULATION ================= */

async function simulate(buyRouter, sellRouter, sizes, pathIn, pathOut) {
  const res = await vault.findBestFlashLoanSize(
    buyRouter,
    sellRouter,
    sizes,
    pathIn,
    pathOut
  );

  return {
    size: BigInt(res.amountIn),
    profit: BigInt(res.estimatedProfit)
  };
}

/* ================= MICRO DETECTION ================= */

async function scan() {

  console.log("\n🔎 MICRO LIQUIDITY SCAN");

  const tokens = Object.values(TOKENS).filter(t => t !== TOKENS.USDC);

  const inters = [TOKENS.WETH, TOKENS.DAI, TOKENS.USDT, TOKENS.WMATIC, TOKENS.WBTC];

  let best = { profit: 0n };

  for (const token of tokens) {

    for (const inter of inters) {

      if (token === inter) continue;

      const r = route(token, inter);

      const sim = await simulate(
        r.buyRouter,
        r.sellRouter,
        BASE_SIZES,
        r.pathToToken,
        r.pathToUSDC
      );

      const eff = efficiency(sim.profit, sim.size);

      console.log(
        `→ token ${token.slice(0,6)} via ${inter.slice(0,6)}`
        + ` | profit ${ethers.formatUnits(sim.profit,6)}`
        + ` | eff ${eff}`
      );

      if (sim.profit > MIN_MICRO_PROFIT) {

        microPool.push({
          ...r,
          size: sim.size,
          profit: sim.profit
        });

        runningProfit += sim.profit;

      }

      if (sim.profit > best.profit) {
        best = { ...sim, route: r };
      }

    }
  }

  console.log(`RUNNING MICRO PROFIT: ${ethers.formatUnits(runningProfit,6)}`);

  return best;
}

/* ================= BATCH SCALING ================= */

function aggregate(pool) {

  const map = new Map();

  for (const t of pool) {

    const key = t.buyRouter + t.sellRouter + JSON.stringify(t.pathToToken);

    if (!map.has(key)) {
      map.set(key, {
        ...t,
        size: 0n,
        profit: 0n
      });
    }

    const g = map.get(key);

    g.size += t.size;
    g.profit += t.profit;
  }

  return [...map.values()];
}

/* ================= EXECUTION ================= */

async function executeBatch(pool) {

  console.log("\n🔥 BATCH EXECUTION START");

  const grouped = aggregate(pool);

  const usable = [];
  let capital = 0n;
  let profit = 0n;

  const vaultBal = BigInt(await provider.getBalance(wallet.address));

  for (const t of grouped) {

    if (capital + t.size > vaultBal) continue;

    capital += t.size;
    profit += t.profit;

    usable.push(t);
  }

  console.log(`MICRO GROUPS: ${grouped.length}`);
  console.log(`USABLE TRADES: ${usable.length}`);
  console.log(`CAPITAL USED: ${ethers.formatUnits(capital,6)}`);
  console.log(`EXPECTED PROFIT: ${ethers.formatUnits(profit,6)}`);

  const tx = await vault.executeBestFlashLoanArbitrage(
    usable[0].buyRouter,
    usable[0].sellRouter,
    BASE_SIZES,
    usable[0].pathToToken,
    usable[0].pathToUSDC,
    Math.floor(Date.now()/1000)+30
  );

  console.log("TX SENT:", tx.hash);

  await tx.wait();

  console.log("EXECUTION CONFIRMED");

  microPool = [];
  runningProfit = 0n;
  executing = false;
}

/* ================= LOOP ================= */

async function main() {

  console.log("🚀 MICRO→MACRO ENGINE STARTED");

  while (true) {

    try {

      const best = await scan();

      if (!executing && runningProfit >= BATCH_TRIGGER) {

        executing = true;

        const batch = [...microPool];

        await executeBatch(batch);

      } else {

        console.log(
          `💤 WAITING | BEST ${ethers.formatUnits(best.profit,6)}`
        );
      }

    } catch (e) {
      console.log("ERROR:", e.message);
    }

    await sleep(2000);
  }
}

main();
