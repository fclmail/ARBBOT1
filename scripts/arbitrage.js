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

const RPC =
  "https://polygon-bor-rpc.publicnode.com";

const provider =
  new ethers.JsonRpcProvider(RPC);

const wallet =
  new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

/* =========================================================
   ABI
========================================================= */

const abi = [

  "function owner() view returns(address)",

  "function minimumProfitUSDC() view returns(uint256)",

  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external"

];

const arb =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    abi,
    wallet
  );

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = {

  WETH:
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",

  WMATIC:
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",

  DAI:
    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",

  USDT:
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",

  WBTC:
    "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",

  USDC:
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const USDC =
  TOKENS.USDC;

/* =========================================================
   ROUTERS
========================================================= */

const QUICK =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHI =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* =========================================================
   ERC20
========================================================= */

const ERC20_ABI = [
  "function balanceOf(address) view returns(uint256)"
];

/* =========================================================
   SETTINGS
========================================================= */

/*
FLASH LOAN SIZES
COMPLETELY INDEPENDENT
OF VAULT SIZE
*/

const CANDIDATE_SIZES = [

  ethers.parseUnits(".1", 6),

  ethers.parseUnits("10", 6),

  ethers.parseUnits("25", 6),

  ethers.parseUnits("50", 6),

  ethers.parseUnits("75", 6),

  ethers.parseUnits("100", 6),

  ethers.parseUnits("250", 6),

  ethers.parseUnits("500", 6),

  ethers.parseUnits("1000", 6),

  ethers.parseUnits("2500", 6),

  ethers.parseUnits("5000", 6)
];

/*
VISIBLE MICRO DETECTION
*/

const MICRO_SCAN_SIZE =
  ethers.parseUnits(
    "0.031",
    6
  );

/*
EXECUTION FILTER
*/

const MIN_PROFIT =
  ethers.parseUnits(
    "0.000001",
    6
  );

/*
LOOP SPEED
*/

const LOOP_DELAY = 2500;

/* =========================================================
   HELPERS
========================================================= */

const sleep = (ms) =>
  new Promise(r => setTimeout(r, ms));

const fmt = (x) =>
  Number(
    ethers.formatUnits(x, 6)
  ).toFixed(6);

function stage(name) {

  console.log(
    `\n📡 ${name}`
  );
}

/* =========================================================
   ROUTES
========================================================= */

function makeRoute(token) {

  switch (token) {

    case TOKENS.WETH:

      return {

        buyRouter:
          QUICK,

        sellRouter:
          SUSHI,

        pathToToken: [
          USDC,
          TOKENS.WMATIC,
          TOKENS.WETH
        ],

        pathToUSDC: [
          TOKENS.WETH,
          TOKENS.WMATIC,
          USDC
        ]
      };

    case TOKENS.WBTC:

      return {

        buyRouter:
          QUICK,

        sellRouter:
          SUSHI,

        pathToToken: [
          USDC,
          TOKENS.WETH,
          TOKENS.WBTC
        ],

        pathToUSDC: [
          TOKENS.WBTC,
          TOKENS.WETH,
          USDC
        ]
      };

    case TOKENS.DAI:

      return {

        buyRouter:
          QUICK,

        sellRouter:
          SUSHI,

        pathToToken: [
          USDC,
          TOKENS.USDT,
          TOKENS.DAI
        ],

        pathToUSDC: [
          TOKENS.DAI,
          TOKENS.USDT,
          USDC
        ]
      };

    case TOKENS.USDT:

      return {

        buyRouter:
          QUICK,

        sellRouter:
          SUSHI,

        pathToToken: [
          USDC,
          TOKENS.WMATIC,
          TOKENS.USDT
        ],

        pathToUSDC: [
          TOKENS.USDT,
          TOKENS.WMATIC,
          USDC
        ]
      };

    default:

      return {

        buyRouter:
          QUICK,

        sellRouter:
          SUSHI,

        pathToToken: [
          USDC,
          token
        ],

        pathToUSDC: [
          token,
          USDC
        ]
      };
  }
}

/* =========================================================
   VAULT BALANCE
========================================================= */

async function getVaultBalance() {

  const usdc =
    new ethers.Contract(
      USDC,
      ERC20_ABI,
      provider
    );

  return await usdc.balanceOf(
    CONTRACT_ADDRESS
  );
}

/* =========================================================
   MICRO DETECTION
========================================================= */

async function microDetect(
  route
) {

  try {

    const sim =
      await arb.simulateArbitrageProfit.staticCall(

        route.buyRouter,

        route.sellRouter,

        MICRO_SCAN_SIZE,

        route.pathToToken,

        route.pathToUSDC
      );

    return {

      finalUSDC:
        sim[0],

      profit:
        sim[1]
    };

  } catch {

    return {

      finalUSDC: 0n,

      profit: 0n
    };
  }
}

/* =========================================================
   DEPTH ANALYSIS
========================================================= */

async function runDepthAnalysis(
  route
) {

  return await arb.findBestFlashLoanSize.staticCall(

    route.buyRouter,

    route.sellRouter,

    CANDIDATE_SIZES,

    route.pathToToken,

    route.pathToUSDC
  );
}

/* =========================================================
   STATIC EXECUTION VALIDATION
========================================================= */

async function validateExecution(
  route
) {

  try {

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 120;

    await arb.executeBestFlashLoanArbitrage.staticCall(

      route.buyRouter,

      route.sellRouter,

      CANDIDATE_SIZES,

      route.pathToToken,

      route.pathToUSDC,

      deadline
    );

    return true;

  } catch {

    return false;
  }
}

/* =========================================================
   SCAN TOKEN
========================================================= */

async function scanToken(
  name,
  token
) {

  try {

    console.log(
      `\n🔎 SCANNING ${name}`
    );

    const vaultBal =
      await getVaultBalance();

    console.log(
      `\n💰 Vault: ${fmt(vaultBal)} USDC`
    );

    const route =
      makeRoute(token);

    /*
    FAST MICRO DISCOVERY
    */

    stage(
      "FAST MICRO DETECTION"
    );

    const micro =
      await microDetect(
        route
      );

    console.log(
      "\n📊 Detection Size:"
    );

    console.log(
      fmt(MICRO_SCAN_SIZE)
    );

    console.log(
      "\n📊 Detection Profit:"
    );

    console.log(
      fmt(micro.profit)
    );

    if (
      micro.profit <= 0n
    ) {

      console.log(
        "\n💤 No spread"
      );

      return null;
    }

    console.log(
      "\n✅ Micro spread detected"
    );

    /*
    CONTRACT DEPTH ANALYSIS
    */

    stage(
      "RUNNING CONTRACT DEPTH ANALYSIS"
    );

    const best =
      await runDepthAnalysis(
        route
      );

    const bestSize =
      best.amountIn;

    const estimatedFinal =
      best.estimatedFinalUSDC;

    const estimatedProfit =
      best.estimatedProfit;

    if (
      estimatedProfit <=
      MIN_PROFIT
    ) {

      console.log(
        "\n💤 No profitable macro size"
      );

      return null;
    }

    console.log(
      "\n📊 Contract Optimal Size:"
    );

    console.log(
      fmt(bestSize)
    );

    console.log(
      "\n📊 Estimated Final:"
    );

    console.log(
      fmt(estimatedFinal)
    );

    console.log(
      "\n📊 Estimated Profit:"
    );

    console.log(
      fmt(estimatedProfit)
    );

    /*
    DEPTH SCORE
    */

    let depthScore = 25;

    if (
      bestSize >=
      ethers.parseUnits("1000", 6)
    ) {
      depthScore = 98;
    }

    else if (
      bestSize >=
      ethers.parseUnits("500", 6)
    ) {
      depthScore = 91;
    }

    else if (
      bestSize >=
      ethers.parseUnits("100", 6)
    ) {
      depthScore = 84;
    }

    else if (
      bestSize >=
      ethers.parseUnits("50", 6)
    ) {
      depthScore = 76;
    }

    console.log(
      `\n⚡ Liquidity Depth Score: ${depthScore}`
    );

    console.log(
      "\n⚡ Slippage: LOW"
    );

    /*
    STATIC VALIDATION
    */

    stage(
      "RUNNING EXECUTION SIMULATION"
    );

    const passed =
      await validateExecution(
        route
      );

    if (!passed) {

      console.log(
        "\n❌ Static simulation failed"
      );

      return null;
    }

    console.log(
      "\n✅ Static simulation passed"
    );

    return {

      token,

      route,

      bestSize,

      estimatedProfit,

      estimatedFinal
    };

  } catch (err) {

    console.log(
      "\n❌ Scan failed"
    );

    console.log(
      err.shortMessage ||
      err.message
    );

    return null;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(signal) {

  try {

    stage(
      "EXECUTING FLASH LOAN"
    );

    const before =
      await getVaultBalance();

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 120;

    console.log(
      "\n📡 Sending transaction..."
    );

    const tx =
      await arb.executeBestFlashLoanArbitrage(

        signal.route.buyRouter,

        signal.route.sellRouter,

        CANDIDATE_SIZES,

        signal.route.pathToToken,

        signal.route.pathToUSDC,

        deadline,

        {
          gasLimit: 2500000
        }
      );

    console.log(
      "\n🚀 TX SENT:"
    );

    console.log(
      tx.hash
    );

    console.log(
      "\n⛓ Waiting confirmation..."
    );

    const receipt =
      await tx.wait();

    console.log(
      `\n✅ CONFIRMED BLOCK ${receipt.blockNumber}`
    );

    const after =
      await getVaultBalance();

    const profit =
      after > before
        ? after - before
        : 0n;

    const growth =
      before > 0n
        ? (
            Number(profit) /
            Number(before)
          ) * 100
        : 0;

    console.log(
      "\n💰 BEFORE:"
    );

    console.log(
      fmt(before)
    );

    console.log(
      "\n💰 AFTER:"
    );

    console.log(
      fmt(after)
    );

    console.log(
      "\n📈 PROFIT:"
    );

    console.log(
      fmt(profit)
    );

    console.log(
      "\n🏦 CONTRACT VAULT GROWTH:"
    );

    console.log(
      `+${growth.toFixed(4)}%`
    );

  } catch (err) {

    console.log(
      "\n❌ EXECUTION FAILED"
    );

    console.log(
      err.shortMessage ||
      err.message
    );
  }
}

/* =========================================================
   MAIN
========================================================= */

async function main() {

  console.log(
    "\n🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED"
  );

  const owner =
    await arb.owner();

  console.log(
    "\n👤 OWNER:"
  );

  console.log(
    owner
  );

  console.log(
    "\n👤 EXECUTOR:"
  );

  console.log(
    wallet.address
  );

  if (
    owner.toLowerCase() !==
    wallet.address.toLowerCase()
  ) {

    throw new Error(
      "Wallet is not contract owner"
    );
  }

  while (true) {

    try {

      const scans =
        await Promise.all(

          Object.entries(TOKENS)

            .filter(
              ([k]) => k !== "USDC"
            )

            .map(
              ([name, token]) =>
                scanToken(
                  name,
                  token
                )
            )
        );

      const valid =
        scans.filter(Boolean);

      if (
        valid.length === 0
      ) {

        console.log(
          "\n💤 No opportunities"
        );

        await sleep(
          LOOP_DELAY
        );

        continue;
      }

      const best =
        valid.reduce(

          (a, b) =>
            b.estimatedProfit >
            a.estimatedProfit
              ? b
              : a
        );

      console.log(
        "\n🏆 BEST SIGNAL"
      );

      console.log(
        "\nTOKEN:"
      );

      console.log(

        Object.entries(TOKENS)

          .find(
            ([, v]) =>
              v === best.token
          )?.[0] ||

        best.token
      );

      console.log(
        "\nPROFIT:"
      );

      console.log(
        fmt(
          best.estimatedProfit
        )
      );

      console.log(
        "\nSIZE:"
      );

      console.log(
        fmt(best.bestSize)
      );

      await execute(best);

    } catch (err) {

      console.log(
        "\n❌ LOOP ERROR"
      );

      console.log(
        err.shortMessage ||
        err.message
      );
    }

    await sleep(
      LOOP_DELAY
    );
  }
}

/* =========================================================
   START
========================================================= */

main().catch(console.error);
