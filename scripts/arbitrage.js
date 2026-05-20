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

const RPCS = [

  "https://polygon-bor-rpc.publicnode.com"

];

let rpcIndex = 0;

function nextRPC() {

  const rpc =
    RPCS[rpcIndex];

  rpcIndex =
    (rpcIndex + 1) %
    RPCS.length;

  return rpc;
}

const provider =
  new ethers.JsonRpcProvider(
    nextRPC()
  );

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

const arbAbi = [

  "function owner() view returns(address)",

  "function minimumProfitUSDC() view returns(uint256)",

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",

  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external"

];

const ROUTER_ABI = [

  "function getAmountsOut(uint,address[]) view returns(uint[])"

];

const ERC20_ABI = [

  "function balanceOf(address) view returns(uint256)"

];

/* =========================================================
   CONTRACT
========================================================= */

const arb =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    arbAbi,
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

  AAVE:
    "0xd6df932a45c0f255f85145f286ea0b292b21c90b",

  LINK:
    "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",

  UNI:
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",

  QUICK:
    "0x831753dd7087cac61ab5644b308642cc1c33dc13",

  SHIB:
    "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",

  CRV:
    "0x172370d5cd63279efa6d502dab29171933a610af",

  USDC:
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const USDC =
  TOKENS.USDC;

/* =========================================================
   ROUTERS
========================================================= */

const routers = {

  QuickSwap:
    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",

  SushiSwap:
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",

  Dfyn:
    "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",

  ApeSwap:
    "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",

  Wault:
    "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"

};

const routerContracts =
  Object.fromEntries(

    Object.values(routers).map(

      r => [

        r,

        new ethers.Contract(
          r,
          ROUTER_ABI,
          provider
        )
      ]
    )
  );

/* =========================================================
   SETTINGS
========================================================= */

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

const MICRO_PROBE =
  ethers.parseUnits(
    "0.02",
    6
  );

const WORKER_COUNT = 32;

const LOOP_DELAY = 5;

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
   PATH BUILDERS
========================================================= */

function buildBuyPaths(token) {

  return [

    [USDC, token],

    [USDC, TOKENS.WETH, token],

    [USDC, TOKENS.WMATIC, token],

    [USDC, TOKENS.DAI, token],

    [USDC, TOKENS.USDT, token]
  ];
}

function buildSellPaths(token) {

  return [

    [token, USDC],

    [token, TOKENS.WETH, USDC],

    [token, TOKENS.WMATIC, USDC],

    [token, TOKENS.DAI, USDC],

    [token, TOKENS.USDT, USDC]
  ];
}

/* =========================================================
   QUOTE
========================================================= */

async function quote(
  router,
  amount,
  path
) {

  try {

    const out =
      await routerContracts[
        router
      ].getAmountsOut(
        amount,
        path
      );

    return out.at(-1);

  } catch {

    return null;
  }
}

/* =========================================================
   VAULT
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
   FAST MICRO FINDER
========================================================= */

async function fastMicroFinder(
  token
) {

  try {

    for (const buy of Object.values(routers)) {

      for (const sell of Object.values(routers)) {

        if (buy === sell)
          continue;

        for (const buyPath of buildBuyPaths(token)) {

          const buyOut =
            await quote(
              buy,
              MICRO_PROBE,
              buyPath
            );

          if (!buyOut)
            continue;

          for (const sellPath of buildSellPaths(token)) {

            const sellOut =
              await quote(
                sell,
                buyOut,
                sellPath
              );

            if (!sellOut)
              continue;

            const profit =
              sellOut -
              MICRO_PROBE;

            if (
              profit >
              MICRO_THRESHOLD
            ) {

              return {

                profit,

                buy,

                sell,

                buyPath,

                sellPath
              };
            }
          }
        }
      }
    }

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

    const micro =
      await fastMicroFinder(
        token
      );

    if (!micro) {

      return null;
    }

    console.log(
      "\n⚡ FAST MICRO SPREAD FOUND"
    );

    console.log(
      `\n📊 Micro Profit:\n${fmt(micro.profit)}`
    );

    console.log(
      "\n📡 Fast spread detected..."
    );

    pipeline(
      "STAGE 2",
      "DEPTH ANALYSIS"
    );

    const route = {

      buyRouter:
        micro.buy,

      sellRouter:
        micro.sell,

      pathToToken:
        micro.buyPath,

      pathToUSDC:
        micro.sellPath
    };

    const candidateSizes = [

      vaultBal / 2n,

      vaultBal,

      vaultBal * 5n,

      vaultBal * 20n,

      vaultBal * 100n,

      ethers.parseUnits(
        "125",
        6
      )

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

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 120;

    await arb
      .executeBestFlashLoanArbitrage
      .staticCall(

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

  } catch {

    return null;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(
  signal,
  tokenName
) {

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
   SCAN TASKS
========================================================= */

const scanTasks = [];

for (
  const [name, token]
  of Object.entries(TOKENS)
) {

  if (name === "USDC")
    continue;

  scanTasks.push({
    name,
    token
  });
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

  let taskIndex = 0;

  async function worker() {

    while (true) {

      try {

        const task =
          scanTasks[
            taskIndex++
            % scanTasks.length
          ];

        const signal =
          await runDepthAnalysis(

            task.name,

            task.token
          );

        if (
          signal &&
          signal.profit >=
          EXECUTION_THRESHOLD
        ) {

          console.log(
            "\n🏆 BEST SIGNAL"
          );

          console.log(
            `\nTOKEN:\n${task.name}`
          );

          console.log(
            `\nPROFIT:\n${fmt(signal.profit)}`
          );

          console.log(
            `\nSIZE:\n${fmt(signal.size)}`
          );

          await execute(
            signal,
            task.name
          );
        }

      } catch {}

      await sleep(
        LOOP_DELAY
      );
    }
  }

  await Promise.all(

    Array.from(

      { length: WORKER_COUNT },

      worker
    )
  );
}

/* =========================================================
   START
========================================================= */

main().catch(console.error);
