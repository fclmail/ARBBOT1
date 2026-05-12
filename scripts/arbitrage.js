
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

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",

  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",

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
ONLY SETTINGS CHANGED
FOR SMALL VAULT EXECUTION
*/

const MICRO_THRESHOLD =
  ethers.parseUnits(
    "0.00001",
    6
  );

const EXECUTION_THRESHOLD =
  ethers.parseUnits(
    "0.00001",
    6
  );

const LOOP_DELAY = 2000;

/* =========================================================
   HELPERS
========================================================= */

const sleep = (ms) =>
  new Promise(r => setTimeout(r, ms));

const fmt = (x) =>
  Number(
    ethers.formatUnits(x, 6)
  ).toFixed(6);

function pipeline(stage, msg) {

  console.log(
    `\n📡 PIPELINE ${stage}: ${msg}`
  );
}

function calcDepthScore(
  profit,
  size
) {

  if (size === 0n)
    return 0;

  const ratio =
    Number(
      (profit * 100000n) / size
    );

  return Math.min(
    Math.max(ratio, 1),
    99
  );
}

function getSlippageLabel(
  score
) {

  if (score >= 80)
    return "LOW";

  if (score >= 50)
    return "MEDIUM";

  return "HIGH";
}

/* =========================================================
   FULL HOP PATHS
========================================================= */

function makeRoute(token) {

  /*
  RESTORED FULL HOP PATHS
  */

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

async function detectMicroSpread(
  token
) {

  try {

    pipeline(
      "STAGE 1",
      "MICRO DETECTION"
    );

    const vaultBal =
      await getVaultBalance();

    /*
    SMALL VAULT ADAPTIVE SIZE
    */

    const amount =

      vaultBal <
      ethers.parseUnits("1", 6)

        ? vaultBal / 2n

        : vaultBal / 5n;

    if (amount <= 0n)
      return null;

    const route =
      makeRoute(token);

    const result =
      await arb.simulateArbitrageProfit.staticCall(

        route.buyRouter,

        route.sellRouter,

        amount,

        route.pathToToken,

        route.pathToUSDC
      );

    const estimatedFinal =
      result[0];

    const estimatedProfit =
      result[1];

    console.log(
      `\n📊 Detection Size:\n${fmt(amount)}`
    );

    console.log(
      `\n📊 Detection Profit:\n${fmt(estimatedProfit)}`
    );

    if (
      estimatedProfit >
      MICRO_THRESHOLD
    ) {

      console.log(
        "\n✅ Micro spread visible"
      );

      return {

        amount,

        estimatedFinal,

        estimatedProfit
      };
    }

    console.log(
      "\n💤 No spread"
    );

    return null;

  } catch {

    return null;
  }
}

/* =========================================================
   DEPTH ANALYSIS
========================================================= */

async function runDepthAnalysis(
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

    const spread =
      await detectMicroSpread(
        token
      );

    if (!spread)
      return null;

    console.log(
      "\n📡 Fast spread detected..."
    );

    pipeline(
      "STAGE 2",
      "DEPTH ANALYSIS"
    );

    const route =
      makeRoute(token);

    /*
    SMALL VAULT DEPTH SEARCH
    */

    const candidateSizes = [

      vaultBal / 2n,

      vaultBal,

      vaultBal * 2n

    ].filter(
      x => x > 0n
    );

    const best =
      await arb.findBestFlashLoanSize.staticCall(

        route.buyRouter,

        route.sellRouter,

        candidateSizes,

        route.pathToToken,

        route.pathToUSDC
      );

    const bestSize =
      best.amountIn;

    const estimatedFinal =
      best.estimatedFinalUSDC;

    const estimatedProfit =
      best.estimatedProfit;

    if (
      estimatedProfit <=
      MICRO_THRESHOLD
    ) {

      return null;
    }

    const score =
      calcDepthScore(
        estimatedProfit,
        bestSize
      );

    const slippage =
      getSlippageLabel(
        score
      );

    console.log(
      `\n📊 Contract Optimal Size:\n${fmt(bestSize)}`
    );

    console.log(
      `\n📊 Estimated Final:\n${fmt(estimatedFinal)}`
    );

    console.log(
      `\n📊 Estimated Profit:\n${fmt(estimatedProfit)}`
    );

    console.log(
      `\n⚡ Liquidity Depth Score: ${score}`
    );

    console.log(
      `\n⚡ Slippage: ${slippage}`
    );

    pipeline(
      "STAGE 3",
      "EXECUTION VALIDATION"
    );

    console.log(
      "\n📡 Running execution simulation..."
    );

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 120;

    /*
    STATIC PASS
    */

    await arb.executeBestFlashLoanArbitrage.staticCall(

      route.buyRouter,

      route.sellRouter,

      [bestSize],

      route.pathToToken,

      route.pathToUSDC,

      deadline
    );

    console.log(
      "\n✅ Static simulation passed"
    );

    return {

      token,

      route,

      size:
        bestSize,

      estimatedFinal,

      profit:
        estimatedProfit,

      score,

      slippage
    };

  } catch (err) {

    console.log(
      "\n❌ Static simulation rejected"
    );

    return null;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(signal) {

  try {

    pipeline(
      "STAGE 4",
      "LIVE BROADCAST"
    );

    console.log(
      "\n🔥 EXECUTING FLASH LOAN"
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

        [signal.size],

        signal.route.pathToToken,

        signal.route.pathToUSDC,

        deadline,

        {
          gasLimit: 3000000
        }
      );

    console.log(
      `\n🚀 TX SENT:\n${tx.hash}`
    );

    console.log(
      "\n⛓ Waiting confirmation..."
    );

    const receipt =
      await tx.wait();

    pipeline(
      "STAGE 5",
      "CONFIRMED"
    );

    console.log(
      `\n✅ CONFIRMED BLOCK ${receipt.blockNumber}`
    );

    const after =
      await getVaultBalance();

    const realizedProfit =
      after > before
        ? after - before
        : 0n;

    const growth =
      before > 0n
        ? (
            Number(realizedProfit) /
            Number(before)
          ) * 100
        : 0;

    console.log(
      `\n💰 BEFORE:\n${fmt(before)}`
    );

    console.log(
      `\n💰 AFTER:\n${fmt(after)}`
    );

    console.log(
      `\n📈 PROFIT:\n${fmt(realizedProfit)}`
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
   MAIN LOOP
========================================================= */

async function main() {

  console.log(
    "\n🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED"
  );

  const owner =
    await arb.owner();

  console.log(
    `\n👤 OWNER:\n${owner}`
  );

  console.log(
    `\n👤 WALLET:\n${wallet.address}`
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
                runDepthAnalysis(
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
            b.profit > a.profit
              ? b
              : a
        );

      console.log(
        "\n🏆 BEST SIGNAL"
      );

      console.log(
        `\nTOKEN:\n${
          Object.entries(TOKENS)
            .find(
              ([, v]) =>
                v === best.token
            )?.[0] || best.token
        }`
      );

      console.log(
        `\nPROFIT:\n${fmt(best.profit)}`
      );

      console.log(
        `\nSIZE:\n${fmt(best.size)}`
      );

      /*
      EXECUTE
      */

      if (
        best.profit >=
        EXECUTION_THRESHOLD
      ) {

        await execute(best);

      } else {

        console.log(
          "\n🛑 Profit below execution threshold"
        );
      }

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
