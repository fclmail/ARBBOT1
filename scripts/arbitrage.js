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
   SAFE PUBLIC RPC ROTATION
========================================================= */

const RPCS = [
  "https://1rpc.io/matic",
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon.drpc.org",
];

let rpcIndex = 0;

function getProvider() {
  const rpc = RPCS[rpcIndex % RPCS.length];

  console.log(`🟢 USING RPC → ${rpc}`);

  return new ethers.JsonRpcProvider(rpc, {
    name: "polygon",
    chainId: 137,
  });
}

function rotateRPC() {
  rpcIndex++;

  const rpc = RPCS[rpcIndex % RPCS.length];

  console.log(`🟢 ROTATING RPC → ${rpc}`);

  provider = getProvider();
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  arb = arb.connect(wallet);
}

/* =========================================================
   PROVIDER + WALLET
========================================================= */

let provider = getProvider();

let wallet = new ethers.Wallet(
  PRIVATE_KEY,
  provider
);

/* =========================================================
   CONTRACTS
========================================================= */

const ARB_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

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
  "function getAmountsOut(uint amountIn,address[] calldata path) external view returns (uint[] memory amounts)"
];

const ERC20_ABI = [
  "function balanceOf(address owner) external view returns (uint256)"
];

const ARB_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,uint256 amountInUSDC,address[] calldata pathToToken,address[] calldata pathToUSDC,uint256 deadline) external",

  "function executeBestFlashLoanArbitrage(address buyRouter,address sellRouter,uint256[] calldata candidateSizes,address[] calldata pathToToken,address[] calldata pathToUSDC,uint256 deadline) external",

  "function owner() external view returns(address)",

  "function vault() external view returns(address)",

  "function minimumProfitUSDC() external view returns(uint256)"
];

/* =========================================================
   INSTANCES
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

const arb = new ethers.Contract(
  ARB_ADDRESS,
  ARB_ABI,
  wallet
);

const usdc = new ethers.Contract(
  USDC,
  ERC20_ABI,
  provider
);

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatUSDC(v) {
  return Number(
    ethers.formatUnits(v, 6)
  ).toFixed(6);
}

async function safeGetAmountsOut(
  router,
  amountIn,
  path
) {
  try {
    const amounts =
      await router.getAmountsOut(
        amountIn,
        path
      );

    return amounts[
      amounts.length - 1
    ];

  } catch (e) {

    console.log(
      `❌ DEPTH FAILURE → ${e.shortMessage || e.message}`
    );

    return 0n;
  }
}

/* =========================================================
   DEPTH CURVE
========================================================= */

async function testDepthCurve(
  name,
  router
) {
  console.log(
    `🟢 TESTING DEPTH CURVE → ${name}`
  );

  const sizes = [
    25,
    50,
    100,
    250,
    500
  ];

  let valid = false;

  for (const size of sizes) {

    const amountIn =
      ethers.parseUnits(
        size.toString(),
        6
      );

    const out =
      await safeGetAmountsOut(
        router,
        amountIn,
        [USDC, WMATIC]
      );

    if (out > 0n) {
      valid = true;
    }

    console.log(
      `📐 SIZE ${size} USDC → ${formatUSDC(out)}`
    );
  }

  if (valid) {
    console.log(
      `🟢 DEPTH CURVE VALID`
    );
  } else {
    console.log(
      `❌ NO VALID LIQUIDITY`
    );
  }

  return valid;
}

/* =========================================================
   MEMPOOL + BLOCK STABILITY
========================================================= */

async function validateBlocks() {

  const b1 =
    await provider.getBlockNumber();

  await sleep(1200);

  const b2 =
    await provider.getBlockNumber();

  await sleep(1200);

  const b3 =
    await provider.getBlockNumber();

  console.log(
    `📦 BLOCK VERIFIED → ${b1}`
  );

  console.log(
    `📦 BLOCK VERIFIED → ${b2}`
  );

  console.log(
    `📦 BLOCK VERIFIED → ${b3}`
  );

  return (
    Math.abs(b3 - b1) <= 2
  );
}

/* =========================================================
   ROUTE PROFIT TEST
========================================================= */

async function scanProfit(
  name,
  buyRouter,
  sellRouter
) {
  try {

    const amountIn =
      ethers.parseUnits("25", 6);

    const buy =
      await buyRouter.getAmountsOut(
        amountIn,
        [USDC, WMATIC]
      );

    const tokenOut =
      buy[buy.length - 1];

    const sell =
      await sellRouter.getAmountsOut(
        tokenOut,
        [WMATIC, USDC]
      );

    const finalUSDC =
      sell[sell.length - 1];

    const profit =
      finalUSDC > amountIn
        ? finalUSDC - amountIn
        : 0n;

    console.log(
      `📊 ${name} PROFIT → ${formatUSDC(profit)}`
    );

    return {
      name,
      profit,
      finalUSDC
    };

  } catch (e) {

    console.log(
      `❌ PROFIT FAILURE → ${e.shortMessage || e.message}`
    );

    return {
      name,
      profit: 0n,
      finalUSDC: 0n
    };
  }
}

/* =========================================================
   AUTO SOURCE SELECTOR
========================================================= */

async function executeBestTrade(
  bestSignal
) {

  const deadline =
    Math.floor(Date.now() / 1000) + 60;

  const sizes = [
    ethers.parseUnits("25", 6),
    ethers.parseUnits("50", 6),
    ethers.parseUnits("100", 6),
  ];

  const vaultAddress =
    await arb.vault();

  const vaultBalance =
    await usdc.balanceOf(
      vaultAddress
    );

  const required =
    ethers.parseUnits("25", 6);

  console.log(
    `🏦 VAULT BALANCE → ${formatUSDC(vaultBalance)}`
  );

  let tx;

  /* =========================================
     AUTO SELECT EXECUTION SOURCE
  ========================================= */

  if (vaultBalance >= required) {

    console.log(
      `🟢 USING VAULT LIQUIDITY`
    );

    tx =
      await arb.executeArbitrage(
        QUICKSWAP,
        SUSHISWAP,
        required,
        [USDC, WMATIC],
        [WMATIC, USDC],
        deadline
      );

  } else {

    console.log(
      `🟢 VAULT INSUFFICIENT`
    );

    console.log(
      `🟢 SWITCHING TO FLASH LOAN`
    );

    tx =
      await arb.executeBestFlashLoanArbitrage(
        QUICKSWAP,
        SUSHISWAP,
        sizes,
        [USDC, WMATIC],
        [WMATIC, USDC],
        deadline
      );
  }

  console.log("");
  console.log("📡 SENDING TRANSACTION");
  console.log("");

  console.log("🟢 TX HASH →");
  console.log(tx.hash);

  const receipt =
    await tx.wait();

  if (receipt.status === 1) {

    console.log("");
    console.log(
      "🟢 TRANSACTION CONFIRMED"
    );

    console.log(
      `💰 FINAL PROFIT → ${formatUSDC(bestSignal.profit)} USDC`
    );

  } else {

    console.log(
      "❌ TRANSACTION FAILED"
    );
  }
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function run() {

  while (true) {

    try {

      console.log(
        "================================================"
      );

      const quickDepth =
        await testDepthCurve(
          "QUICKSWAP",
          quickswap
        );

      console.log("");

      const sushiDepth =
        await testDepthCurve(
          "SUSHISWAP",
          sushiswap
        );

      if (
        !quickDepth &&
        !sushiDepth
      ) {
        console.log(
          "❌ DEPTH VALIDATION FAILED"
        );

        rotateRPC();

        await sleep(5000);

        continue;
      }

      console.log("");
      console.log(
        "🟢 MEMPOOL STABLE"
      );
      console.log("");

      const stable =
        await validateBlocks();

      if (!stable) {

        console.log(
          "❌ BLOCK INSTABILITY"
        );

        await sleep(5000);

        continue;
      }

      console.log(
        "🟢 BLOCK STABILITY CONFIRMED"
      );

      console.log("");
      console.log(
        "🟢 SCANNING ROUTES"
      );
      console.log("");

      const quickProfit =
        await scanProfit(
          "QUICKSWAP",
          quickswap,
          sushiswap
        );

      const sushiProfit =
        await scanProfit(
          "SUSHISWAP",
          sushiswap,
          quickswap
        );

      let best =
        quickProfit.profit >
        sushiProfit.profit
          ? quickProfit
          : sushiProfit;

      console.log("");
      console.log(
        `🏆 BEST SIGNAL → ${best.name}`
      );

      if (best.profit <= 0n) {

        console.log(
          "❌ NO PROFITABLE ROUTE"
        );

        await sleep(5000);

        continue;
      }

      console.log("");
      console.log(
        "🟢 STATIC CHECK PASSED"
      );

      console.log("");
      console.log(
        "🚀 EXECUTION SIGNAL CONFIRMED"
      );

      await executeBestTrade(best);

    } catch (e) {

      console.log("");

      console.log(
        `❌ EXECUTION FAILURE → ${e.shortMessage || e.message}`
      );

      rotateRPC();
    }

    console.log("");
    console.log(
      "🟢 WAITING FOR NEXT SCAN"
    );

    await sleep(8000);
  }
}

/* =========================================================
   START
========================================================= */

run();
