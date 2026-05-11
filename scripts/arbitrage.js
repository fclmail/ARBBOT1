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
  throw new Error("Missing PRIVATE_KEY");

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
   HELPERS
========================================================= */

const sleep = (ms) =>
  new Promise(r => setTimeout(r, ms));

const fmt = (x) =>
  Number(
    ethers.formatUnits(x, 6)
  ).toFixed(6);

function makeRoute(token) {

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

function calcLiquidityScore(
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

function slippageLabel(score) {

  if (score >= 80)
    return "LOW";

  if (score >= 50)
    return "MEDIUM";

  return "HIGH";
}

/* =========================================================
   CONTRACT VAULT BALANCE
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
   FAST SPREAD DETECTION
========================================================= */

async function fastSpreadDetection(
  token
) {

  try {

    const route =
      makeRoute(token);

    const amount =
      ethers.parseUnits("5", 6);

    const result =
      await arb.simulateArbitrageProfit.staticCall(

        route.buyRouter,

        route.sellRouter,

        amount,

        route.pathToToken,

        route.pathToUSDC
      );

    return result[1] > 0n;

  } catch {

    return false;
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

    /* ==========================================
       FAST DETECTION
    ========================================== */

    const spreadExists =
      await fastSpreadDetection(
        token
      );

    if (!spreadExists) {

      console.log(
        "\n💤 No spread"
      );

      return null;
    }

    console.log(
      "\n📡 Fast spread detected..."
    );

    console.log(
      "\n📡 Running contract depth analysis..."
    );

    const route =
      makeRoute(token);

    /* ==========================================
       DYNAMIC CONTINUOUS CANDIDATES
    ========================================== */

    const candidateSizes = [

      vaultBal / 2n,

      vaultBal,

      vaultBal * 2n,

      vaultBal * 5n,

      vaultBal * 10n,

      vaultBal * 20n,

      vaultBal * 50n

    ].filter(x => x > 0n);

    /* ==========================================
       STATIC PASS #1
       CONTRACT PRIMARY SIGNAL
    ========================================== */

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
      estimatedProfit <= 0n
    ) {

      console.log(
        "\n❌ No profitable size"
      );

      return null;
    }

    const score =
      calcLiquidityScore(
        estimatedProfit,
        bestSize
      );

    const slippage =
      slippageLabel(score);

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

    console.log(
      "\n📡 Running execution simulation..."
    );

    /* ==========================================
       STATIC PASS #2
       FULL EXECUTION VALIDATION
    ========================================== */

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 60;

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
      "\n❌ DEPTH ANALYSIS FAILED"
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
      "\n🔥 EXECUTING FLASH LOAN"
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

        await sleep(2000);

        continue;
      }

      /* ======================================
         CONTRACT SIGNAL PRIMARY
      ====================================== */

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

      /* ======================================
         EXECUTION THRESHOLD
      ====================================== */

      const MIN_EXECUTION_PROFIT =
        ethers.parseUnits(
          "0.000003",
          6
        );

      if (
        best.profit >=
        MIN_EXECUTION_PROFIT
      ) {

        await execute(best);

      } else {

        console.log(
          "\n🛑 Profit below threshold"
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
