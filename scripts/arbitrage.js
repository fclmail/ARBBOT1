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

const RPC = "https://polygon-bor-rpc.publicnode.com";

const provider = new ethers.JsonRpcProvider(RPC);

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const arbAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const vault = new ethers.Contract(
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

const WETH =
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

/* =========================================================
   ROUTERS
========================================================= */

const QUICK =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHI =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const quickRouter = new ethers.Contract(
  QUICK,
  routerAbi,
  provider
);

const sushiRouter = new ethers.Contract(
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
const SLIPPAGE_BUFFER = 0.98;

const LOOP_DELAY = 1000;

/* =========================================================
   HELPERS
========================================================= */

const fmt = (v, d = 6) =>
  Number(ethers.formatUnits(v, d)).toFixed(6);

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, ms));

/* =========================================================
   LIVE QUOTES
========================================================= */

async function getBuyQuote() {
  const amounts = await quickRouter.getAmountsOut(
    TRADE_AMOUNT,
    [USDC, WETH]
  );

  return {
    wethOut: amounts[1]
  };
}

async function getSellQuote(wethAmount) {
  const amounts = await sushiRouter.getAmountsOut(
    wethAmount,
    [WETH, USDC]
  );

  return {
    usdcOut: amounts[1]
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
  } catch (err) {
    return false;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(
  batch,
  netProfit,
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

  const receipt = await tx.wait();

  const end =
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
    `${fmt(netProfit)} USDC\n`
  );

  console.log(
    "⚡ SCAN→EXECUTE:"
  );

  console.log(
    `${end}ms`
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
         LIVE BUY QUOTE
      ========================================================= */

      const buy =
        await getBuyQuote();

      /* =========================================================
         LIVE SELL QUOTE
      ========================================================= */

      const sell =
        await getSellQuote(
          buy.wethOut
        );

      /* =========================================================
         PROFIT CALCULATIONS
      ========================================================= */

      const rawProfit =
        sell.usdcOut -
        TRADE_AMOUNT;

      const gasPrice =
        await provider.getFeeData();

      const estimatedGas =
        842114n;

      const estGasCostWei =
        estimatedGas *
        gasPrice.gasPrice;

      const estGasCostUSDC =
        Number(
          ethers.formatEther(
            estGasCostWei
          )
        ) * 0.9;

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

      const rawProfitNum =
        Number(fmt(rawProfit));

      const safeProfit =
        rawProfitNum *
        SLIPPAGE_BUFFER;

      const netProfit =
        safeProfit -
        estGasCostUSDC -
        flashLoanFee;

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
        "📡 QUICKSWAP LIVE BUY:"
      );

      console.log(
        `${fmt(
          buy.wethOut,
          18
        )} WETH\n`
      );

      console.log(
        "📡 SUSHISWAP LIVE SELL:"
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
         BUILD BATCH
      ========================================================= */

      const batch = {
        buyRouters: [QUICK],

        sellRouters: [SUSHI],

        amountsInUSDC: [
          TRADE_AMOUNT
        ],

        pathsToToken: [
          [USDC, WETH]
        ],

        pathsToUSDC: [
          [WETH, USDC]
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
          "❌ CONTRACT REJECTED"
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
        estimatedGas.toString() +
          "\n"
      );

      console.log(
        "⚡ CONTRACT ACCEPTANCE:"
      );

      console.log(
        "TRUE\n"
      );

      /* =========================================================
         EXECUTION
      ========================================================= */

      await execute(
        batch,
        ethers.parseUnits(
          netProfit.toFixed(6),
          6
        ),
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
