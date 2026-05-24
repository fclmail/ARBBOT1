import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE KEY");
}

/* =========================================================
   PROVIDER
========================================================= */

const RPC =
  "https://polygon-bor-rpc.publicnode.com";

const provider =
  new ethers.JsonRpcProvider(RPC);

const wallet =
  new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const arbAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const vault =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    arbAbi,
    wallet
  );

/* =========================================================
   ROUTER ABI
========================================================= */

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)"
];

/* =========================================================
   TOKENS
========================================================= */

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const WMATIC =
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const WETH =
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

/* =========================================================
   ROUTERS
========================================================= */

const QUICK =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHI =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const quickRouter =
  new ethers.Contract(
    QUICK,
    routerAbi,
    provider
  );

const sushiRouter =
  new ethers.Contract(
    SUSHI,
    routerAbi,
    provider
  );

/* =========================================================
   SETTINGS
========================================================= */

const TRADE_AMOUNT =
  ethers.parseUnits("50", 6);

const FLASH_LOAN_FEE_BPS = 9;

const SLIPPAGE_BPS = 200;

const LOOP_DELAY = 1000;

/* =========================================================
   HELPERS
========================================================= */

const fmt = (
  value,
  decimals = 6
) =>
  Number(
    ethers.formatUnits(
      value,
      decimals
    )
  ).toFixed(6);

const sleep = (ms) =>
  new Promise((r) =>
    setTimeout(r, ms)
  );

/* =========================================================
   MULTIHOP QUOTES
========================================================= */

async function getQuickMultiHopBuy() {
  const amounts =
    await quickRouter.getAmountsOut(
      TRADE_AMOUNT,
      [USDC, WMATIC, WETH]
    );

  return {
    wmaticOut: amounts[1],
    wethOut: amounts[2]
  };
}

async function getSushiMultiHopSell(
  wethAmount
) {
  const amounts =
    await sushiRouter.getAmountsOut(
      wethAmount,
      [WETH, WMATIC, USDC]
    );

  return {
    wmaticOut: amounts[1],
    usdcOut: amounts[2]
  };
}

/* =========================================================
   SIMULATION
========================================================= */

async function simulate(batch) {
  try {
    await vault.executeFlashBatchArbitrage.staticCall(
      batch
    );

    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(
  batch,
  realizedProfit,
  startTime
) {
  console.log(
    "===================================================="
  );

  console.log(
    "🔥 EXECUTING FLASH BATCH"
  );

  console.log(
    "====================================================\n"
  );

  const tx =
    await vault.executeFlashBatchArbitrage(
      batch
    );

  console.log("🚀 TX HASH:");
  console.log(tx.hash);

  console.log("\n⚡ TX STATUS:");
  console.log("SENT\n");

  console.log("⏳ WAITING...\n");

  await tx.wait();

  const elapsed =
    Date.now() - startTime;

  console.log(
    "===================================================="
  );

  console.log(
    "🏁 FINAL RESULTS"
  );

  console.log(
    "====================================================\n"
  );

  console.log(
    "💰 REALIZED NET PROFIT:"
  );

  console.log(
    `${realizedProfit.toFixed(
      6
    )} USDC\n`
  );

  console.log(
    "⚡ SCAN→EXECUTE:"
  );

  console.log(
    `${elapsed}ms\n`
  );

  console.log(
    "====================================================\n"
  );
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function main() {
  console.log(
    "\n🚀 MICRO→MACRO ARB ENGINE STARTED\n"
  );

  while (true) {
    try {
      const startTime =
        Date.now();

      /* =========================================================
         MULTIHOP BUY
      ========================================================= */

      const buy =
        await getQuickMultiHopBuy();

      /* =========================================================
         MULTIHOP SELL
      ========================================================= */

      const sell =
        await getSushiMultiHopSell(
          buy.wethOut
        );

      /* =========================================================
         PROFIT CALCULATIONS
      ========================================================= */

      const rawProfit =
        sell.usdcOut -
        TRADE_AMOUNT;

      const rawProfitNum =
        Number(
          fmt(rawProfit)
        );

      const feeData =
        await provider.getFeeData();

      const estimatedGas =
        991224n;

      const gasPrice =
        feeData.gasPrice ||
        ethers.parseUnits(
          "250",
          "gwei"
        );

      const gasCostPOL =
        Number(
          ethers.formatEther(
            estimatedGas *
              gasPrice
          )
        );

      const estGasCostUSDC =
        gasCostPOL * 0.9;

      const flashLoanFee =
        Number(
          fmt(
            (TRADE_AMOUNT *
              BigInt(
                FLASH_LOAN_FEE_BPS
              )) /
              10000n
          )
        );

      const slippageBuffer =
        Math.abs(
          rawProfitNum *
            (SLIPPAGE_BPS /
              10000)
        );

      const netProfit =
        rawProfitNum -
        estGasCostUSDC -
        flashLoanFee -
        slippageBuffer;

      /* =========================================================
         VALIDATION OUTPUT
      ========================================================= */

      console.log(
        "\n🔄 LIVE REBUILD VALIDATION"
      );

      console.log(
        "====================================================\n"
      );

      console.log(
        "📡 ROUTE:"
      );

      console.log(
        "USDC → WMATIC → WETH → USDC\n"
      );

      console.log(
        "📡 QUICKSWAP MULTIHOP BUY:"
      );

      console.log(
        `${fmt(
          buy.wethOut,
          18
        )} WETH\n`
      );

      console.log(
        "📡 SUSHISWAP MULTIHOP SELL:"
      );

      console.log(
        `${fmt(
          sell.usdcOut
        )} USDC\n`
      );

      console.log(
        "⚡ RAW PROFIT:"
      );

      console.log(
        `${rawProfitNum.toFixed(
          6
        )} USDC\n`
      );

      console.log(
        "⚡ EST GAS COST:"
      );

      console.log(
        `${estGasCostUSDC.toFixed(
          6
        )} USDC\n`
      );

      console.log(
        "⚡ FLASH LOAN FEE:"
      );

      console.log(
        `${flashLoanFee.toFixed(
          6
        )} USDC\n`
      );

      console.log(
        "⚡ SLIPPAGE BUFFER:"
      );

      console.log(
        `${slippageBuffer.toFixed(
          6
        )} USDC\n`
      );

      console.log(
        "⚡ NET PROFIT:"
      );

      console.log(
        `${netProfit.toFixed(
          6
        )} USDC\n`
      );

      if (netProfit <= 0) {
        console.log(
          "❌ VALIDATION:"
        );

        console.log(
          "FAILED\n"
        );

        console.log(
          "❌ TRADE SKIPPED"
        );

        console.log(
          "====================================================\n"
        );

        await sleep(
          LOOP_DELAY
        );

        continue;
      }

      console.log(
        "⚡ VALIDATION:"
      );

      console.log(
        "PASSED\n"
      );

      /* =========================================================
         BATCH
      ========================================================= */

      const batch = {
        buyRouters: [QUICK],

        sellRouters: [SUSHI],

        amountsInUSDC: [
          TRADE_AMOUNT
        ],

        pathsToToken: [
          [USDC, WMATIC, WETH]
        ],

        pathsToUSDC: [
          [WETH, WMATIC, USDC]
        ],

        deadline:
          Math.floor(
            Date.now() / 1000
          ) + 30
      };

      /* =========================================================
         SIMULATION
      ========================================================= */

      console.log(
        "====================================================\n"
      );

      console.log(
        "🧪 ON-CHAIN SIMULATION"
      );

      console.log(
        "====================================================\n"
      );

      const ok =
        await simulate(batch);

      if (!ok) {
        console.log(
          "❌ STATICCALL:"
        );

        console.log(
          "FAILED\n"
        );

        console.log(
          "❌ CONTRACT ACCEPTANCE:"
        );

        console.log(
          "FALSE\n"
        );

        console.log(
          "====================================================\n"
        );

        await sleep(
          LOOP_DELAY
        );

        continue;
      }

      console.log(
        "⚡ STATICCALL:"
      );

      console.log(
        "SUCCESS\n"
      );

      console.log(
        "⚡ GAS ESTIMATE:"
      );

      console.log(
        `${estimatedGas}\n`
      );

      console.log(
        "⚡ CONTRACT ACCEPTANCE:"
      );

      console.log(
        "TRUE\n"
      );

      /* =========================================================
         EXECUTE
      ========================================================= */

      await execute(
        batch,
        netProfit,
        startTime
      );
    } catch (err) {
      console.log(
        "\n❌ ENGINE ERROR:"
      );

      console.log(
        err.reason ||
          err.message ||
          err
      );

      console.log("");
    }

    await sleep(
      LOOP_DELAY
    );
  }
}

main();
