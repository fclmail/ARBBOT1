import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   ENV
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY)
  throw new Error("Missing private key");

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

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external",

  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external"

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
   HELPERS
========================================================= */

const fmt = (x) =>
  Number(
    ethers.formatUnits(x, 6)
  ).toFixed(6);

const sleep = (ms) =>
  new Promise(r => setTimeout(r, ms));

function liquidityScore(profit, size) {

  if (size === 0n)
    return 0;

  const score =
    Number(
      (profit * 10000n) / size
    );

  return Math.min(score, 99);
}

function slippageLabel(score) {

  if (score >= 80)
    return "LOW";

  if (score >= 50)
    return "MEDIUM";

  return "HIGH";
}

function makeRoute(token) {

  return {

    buyRouter: QUICK,

    sellRouter: SUSHI,

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
   SCAN TOKEN
========================================================= */

async function scanToken(
  name,
  token
) {

  try {

    console.log(`\n🔎 SCANNING ${name}`);

    const vaultBal =
      await getVaultBalance();

    console.log(
      `💰 Vault: ${fmt(vaultBal)} USDC`
    );

    const route =
      makeRoute(token);

    /* ==========================================
       CANDIDATE SIZES
    ========================================== */

    const candidateSizes = [

      ethers.parseUnits("5", 6),

      ethers.parseUnits("10", 6),

      ethers.parseUnits("25", 6),

      ethers.parseUnits("50", 6),

      ethers.parseUnits("75", 6),

      ethers.parseUnits("100", 6),

      ethers.parseUnits("250", 6),

      ethers.parseUnits("500", 6)

    ];

    /* ==========================================
       STATIC SIMULATION
    ========================================== */

    const best =
      await arb.findBestFlashLoanSize.staticCall(

        route.buyRouter,

        route.sellRouter,

        candidateSizes,

        route.pathToToken,

        route.pathToUSDC
      );

    const amountIn =
      best.amountIn;

    const estimatedFinal =
      best.estimatedFinalUSDC;

    const estimatedProfit =
      best.estimatedProfit;

    if (
      estimatedProfit <= 0n
    ) {

      console.log(
        "💤 No profitable depth"
      );

      return null;
    }

    const score =
      liquidityScore(
        estimatedProfit,
        amountIn
      );

    const slip =
      slippageLabel(score);

    console.log(
      `📊 Estimated Profit: ${fmt(estimatedProfit)}`
    );

    console.log(
      `📊 Best Size: ${fmt(amountIn)}`
    );

    console.log(
      `📊 Estimated Final: ${fmt(estimatedFinal)}`
    );

    console.log(
      `⚡ Liquidity Depth Score: ${score}`
    );

    console.log(
      `⚡ Slippage: ${slip}`
    );

    return {

      token,

      route,

      profit:
        estimatedProfit,

      size:
        amountIn,

      estimatedFinal,

      score,

      slippage:
        slip
    };

  } catch (err) {

    console.log(
      `❌ Scan failed for ${name}`
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

    console.log(
      `\n🔥 EXECUTING FLASH LOAN`
    );

    const before =
      await getVaultBalance();

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 60;

    console.log(
      "\n📡 Sending transaction..."
    );

    /* ==========================================
       CALL STATIC SAFETY CHECK
    ========================================== */

    await arb.executeBestFlashLoanArbitrage.staticCall(

      signal.route.buyRouter,

      signal.route.sellRouter,

      [signal.size],

      signal.route.pathToToken,

      signal.route.pathToUSDC,

      deadline
    );

    /* ==========================================
       LIVE TX
    ========================================== */

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
      `\n💰 BEFORE: ${fmt(before)}`
    );

    console.log(
      `💰 AFTER : ${fmt(after)}`
    );

    console.log(
      `\n📈 PROFIT: ${fmt(realizedProfit)}`
    );

    console.log(
      `\n🏦 CONTRACT VAULT GROWTH:`
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
    `\n👤 OWNER: ${owner}`
  );

  console.log(
    `👤 WALLET: ${wallet.address}`
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

      const results =
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
        results.filter(Boolean);

      if (
        valid.length === 0
      ) {

        console.log(
          "\n💤 No opportunity"
        );

        await sleep(2000);

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
        `\n🏆 BEST SIGNAL`
      );

      console.log(
        `TOKEN: ${best.token}`
      );

      console.log(
        `PROFIT: ${fmt(best.profit)}`
      );

      console.log(
        `SIZE: ${fmt(best.size)}`
      );

      /* ======================================
         EXECUTION THRESHOLD
      ====================================== */

      const MIN_EXECUTION_PROFIT =
        ethers.parseUnits(
          "0.03",
          6
        );

      if (
        best.profit >=
        MIN_EXECUTION_PROFIT
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

    await sleep(2000);
  }
}

/* =========================================================
   START
========================================================= */

main().catch(console.error);
