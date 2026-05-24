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

const LINK =
  "0x53E0bca35eC356BD5ddDFebBD1Fc0fD03FaBad39";

const WBTC =
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";

const DAI =
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";

const CRV =
  "0x172370d5Cd63279eFa6d502DAB29171933a610AF";

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

const GAS_ESTIMATE = 1001244n;

const LOOP_DELAY = 1000;

/* =========================================================
   ROUTES
========================================================= */

const ROUTES = [
  {
    symbol: "WETH",
    token: WETH,
    decimals: 18
  },

  {
    symbol: "LINK",
    token: LINK,
    decimals: 18
  },

  {
    symbol: "WBTC",
    token: WBTC,
    decimals: 8
  },

  {
    symbol: "DAI",
    token: DAI,
    decimals: 18
  },

  {
    symbol: "CRV",
    token: CRV,
    decimals: 18
  }
];

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
   MULTIHOP QUOTE
========================================================= */

async function getBuyQuote(
  tokenAddress
) {
  const amounts =
    await quickRouter.getAmountsOut(
      TRADE_AMOUNT,
      [
        USDC,
        WMATIC,
        tokenAddress
      ]
    );

  return amounts[2];
}

async function getSellQuote(
  tokenAddress,
  amountIn
) {
  const amounts =
    await sushiRouter.getAmountsOut(
      amountIn,
      [
        tokenAddress,
        WMATIC,
        USDC
      ]
    );

  return amounts[2];
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
  symbol,
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
    `${netProfit.toFixed(
      6
    )} USDC\n`
  );

  console.log(
    "⚡ EXECUTED ROUTE:"
  );

  console.log(
    `USDC → WMATIC → ${symbol} → USDC\n`
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
      console.log(
        "\n🔄 MULTI-ASSET TRIANGULAR SCAN"
      );

      console.log(
        "====================================================\n"
      );

      for (const route of ROUTES) {
        const startTime =
          Date.now();

        try {
          /* =========================================================
             BUY QUOTE
          ========================================================= */

          const tokenOut =
            await getBuyQuote(
              route.token
            );

          /* =========================================================
             SELL QUOTE
          ========================================================= */

          const usdcOut =
            await getSellQuote(
              route.token,
              tokenOut
            );

          /* =========================================================
             CALCULATIONS
          ========================================================= */

          const rawProfit =
            usdcOut -
            TRADE_AMOUNT;

          const rawProfitNum =
            Number(
              fmt(rawProfit)
            );

          const feeData =
            await provider.getFeeData();

          const gasPrice =
            feeData.gasPrice ||
            ethers.parseUnits(
              "250",
              "gwei"
            );

          const gasCostPOL =
            Number(
              ethers.formatEther(
                GAS_ESTIMATE *
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
             OUTPUT
          ========================================================= */

          console.log(
            "📡 SCANNING:"
          );

          console.log(
            `${route.symbol}`
          );

          console.log(
            `USDC → WMATIC → ${route.symbol} → USDC\n`
          );

          console.log(
            "📡 QUICKSWAP BUY:"
          );

          console.log(
            `${fmt(
              tokenOut,
              route.decimals
            )} ${route.symbol}\n`
          );

          console.log(
            "📡 SUSHISWAP SELL:"
          );

          console.log(
            `${fmt(
              usdcOut
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

          /* =========================================================
             VALIDATION
          ========================================================= */

          if (netProfit <= 0) {
            console.log(
              "❌ RESULT:"
            );

            console.log(
              "SKIPPED\n"
            );

            console.log(
              "====================================================\n"
            );

            continue;
          }

          console.log(
            "⚡ RESULT:"
          );

          console.log(
            "PROFITABLE\n"
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
              [
                USDC,
                WMATIC,
                route.token
              ]
            ],

            pathsToUSDC: [
              [
                route.token,
                WMATIC,
                USDC
              ]
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
            await simulate(
              batch
            );

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
            `${GAS_ESTIMATE}\n`
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
            route.symbol,
            netProfit,
            startTime
          );
        } catch (err) {
          console.log(
            `❌ ${route.symbol} ERROR:`
          );

          console.log(
            err.reason ||
              err.message ||
              err
          );

          console.log(
            "====================================================\n"
          );
        }
      }
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
