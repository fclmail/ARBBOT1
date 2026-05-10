import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

/* ================= PROVIDER ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS = "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const ABI = [
  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns (tuple(uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",
  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256)",
  "function minimumProfitUSDC() view returns (uint256)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/* ================= ROUTERS ================= */

const QUICKSWAP = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ================= CONFIG ================= */

const MIN_EXECUTE = ethers.parseUnits("0.000001", 6);
const SIGNAL = ethers.parseUnits("0.0001", 6);
const LOOP_DELAY = 2000;

/* ================= SIZE RANGE ================= */

const SIZES = [
  ethers.parseUnits("500", 6),
  ethers.parseUnits("1000", 6),
  ethers.parseUnits("2500", 6),
  ethers.parseUnits("5000", 6),
  ethers.parseUnits("10000", 6),
  ethers.parseUnits("25000", 6)
];

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================= SAFE SIMULATION ================= */

async function safeSim(buy, sell, size, pathToToken, pathToUSDC) {
  try {
    const result = await contract.findBestFlashLoanSize(
      buy,
      sell,
      SIZES,
      pathToToken,
      pathToUSDC
    );

    return {
      amount: result.amountIn,
      profit: result.estimatedProfit
    };
  } catch (e) {
    return {
      amount: 0n,
      profit: 0n
    };
  }
}

/* ================= ROUTE BUILDER ================= */

function buildRoute(token, inter = null) {
  if (inter) {
    return {
      buy: QUICKSWAP,
      sell: SUSHISWAP,
      pathToToken: [TOKENS.USDC, inter, token],
      pathToUSDC: [token, inter, TOKENS.USDC],
      deadline: Math.floor(Date.now() / 1000) + 60
    };
  }

  return {
    buy: QUICKSWAP,
    sell: SUSHISWAP,
    pathToToken: [TOKENS.USDC, token],
    pathToUSDC: [token, TOKENS.USDC],
    deadline: Math.floor(Date.now() / 1000) + 60
  };
}

/* ================= SCAN ENGINE ================= */

async function scan() {
  console.log("\n🔎 Multi-hop scanning...");

  const tokens = Object.entries(TOKENS).filter(([k]) => k !== "USDC");

  const inters = [
    TOKENS.USDT,
    TOKENS.DAI,
    TOKENS.WETH,
    TOKENS.WMATIC,
    TOKENS.WBTC
  ];

  let best = { profit: 0n };

  for (const [name, addr] of tokens) {

    // DIRECT
    const d = buildRoute(addr);
    const dSim = await safeSim(d.buy, d.sell, 0, d.pathToToken, d.pathToUSDC);

    console.log(`${name} direct:`, ethers.formatUnits(dSim.profit, 6));

    if (dSim.profit > best.profit) {
      best = { token: addr, route: d, profit: dSim.profit, size: dSim.amount };
    }

    // MULTI HOP
    for (const i of inters) {
      if (i === addr) continue;

      const r = buildRoute(addr, i);
      const sim = await safeSim(r.buy, r.sell, 0, r.pathToToken, r.pathToUSDC);

      console.log(`${name} via ${i.slice(0,6)}:`, ethers.formatUnits(sim.profit, 6));

      if (sim.profit > best.profit) {
        best = { token: addr, route: r, profit: sim.profit, size: sim.amount };
      }
    }
  }

  if (best.profit === 0n) {
    console.log("⚠️ No profitable route");
  }

  return best;
}

/* ================= EXECUTION ================= */

async function execute(best) {
  console.log("\n🔥 EXECUTING TRADE");

  console.log("Profit:", ethers.formatUnits(best.profit, 6));

  const tx = await contract.executeAaveFlashLoanArbitrage(
    best.route.buy,
    best.route.sell,
    best.size || ethers.parseUnits("1000", 6),
    best.route.pathToToken,
    best.route.pathToUSDC,
    best.route.deadline
  );

  console.log("TX:", tx.hash);

  await tx.wait();

  console.log("✅ CONFIRMED");
}

/* ================= MAIN LOOP ================= */

async function main() {
  console.log("==================================");
  console.log("POLYGON ARB BOT STARTED");
  console.log("==================================");

  console.log("Min Exec:", ethers.formatUnits(MIN_EXECUTE, 6));
  console.log("Signal:", ethers.formatUnits(SIGNAL, 6));

  let cycle = 0;

  while (true) {
    try {
      cycle++;
      console.log(`\n--- Cycle ${cycle} ---`);

      const best = await scan();

      console.log("Best Profit:", ethers.formatUnits(best.profit, 6));

      if (best.profit > SIGNAL) {
        console.log("🔥 SIGNAL DETECTED");
        await execute(best);
      } else {
        console.log("💤 No trade");
      }

    } catch (e) {
      console.log("Error:", e.reason || e.message);
    }

    await sleep(LOOP_DELAY);
  }
}

main();
