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

  throw new Error(
    "Missing PRIVATE_KEY"
  );
}

/* =========================================================
   RPC
========================================================= */

const RPCS = [

  "https://polygon-bor-rpc.publicnode.com",

  "https://polygon-rpc.com",

  "https://rpc.ankr.com/polygon",

  "https://1rpc.io/matic"

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

  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256) external",

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)"

];

const routerAbi = [

  "function getAmountsOut(uint,address[]) view returns(uint[])",

  "function factory() view returns(address)"
];

const pairAbi = [

  "function token0() view returns(address)",

  "function token1() view returns(address)",

  "function getReserves() view returns(uint112,uint112,uint32)"
];

const factoryAbi = [

  "function getPair(address,address) view returns(address)"
];

const erc20Abi = [

  "function balanceOf(address) view returns(uint256)",

  "function decimals() view returns(uint8)"
];

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

  QUICK:
    "0x831753dd7087cac61ab5644b308642cc1c33dc13",

  LINK:
    "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",

  UNI:
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",

  CRV:
    "0x172370d5cd63279efa6d502dab29171933a610af",

  AAVE:
    "0xd6df932a45c0f255f85145f286ea0b292b21c90b",

  SHIB:
    "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",

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

      router => [

        router,

        new ethers.Contract(
          router,
          routerAbi,
          provider
        )
      ]
    )
  );

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
   SETTINGS
========================================================= */

const MICRO_PROBE =
  ethers.parseUnits(
    "0.02",
    6
  );

const MICRO_THRESHOLD =
  ethers.parseUnits(
    "0.00005",
    6
  );

const EXECUTION_THRESHOLD =
  ethers.parseUnits(
    "0.00010",
    6
  );

const LOOP_DELAY = 25;

const WORKER_COUNT = 16;

let EXECUTING = false;

/* =========================================================
   HELPERS
========================================================= */

const sleep = (ms) =>
  new Promise(
    r => setTimeout(r, ms)
  );

const fmt = (x) =>
  Number(
    ethers.formatUnits(x, 6)
  ).toFixed(6);

function pipeline(stage, msg) {

  console.log(
    `\n📡 PIPELINE ${stage}: ${msg}`
  );
}

/* =========================================================
   PATH BUILDERS
========================================================= */

function buildBuyPaths(token) {

  return [

    [USDC, token],

    [USDC, TOKENS.WETH, token],

    [USDC, TOKENS.WMATIC, token]
  ];
}

function buildSellPaths(token) {

  return [

    [token, USDC],

    [token, TOKENS.WETH, USDC],

    [token, TOKENS.WMATIC, USDC]
  ];
}

/* =========================================================
   CONSTANT PRODUCT MODEL
========================================================= */

function getAmountOut(
  amountIn,
  reserveIn,
  reserveOut
) {

  const amountInWithFee =
    amountIn * 997n;

  const numerator =
    amountInWithFee *
    reserveOut;

  const denominator =
    (reserveIn * 1000n) +
    amountInWithFee;

  return numerator /
    denominator;
}

/* =========================================================
   GET PAIR RESERVES
========================================================= */

async function getPairReserves(
  router,
  tokenA,
  tokenB
) {

  try {

    const factoryAddress =
      await routerContracts[
        router
      ].factory();

    const factory =
      new ethers.Contract(
        factoryAddress,
        factoryAbi,
        provider
      );

    const pairAddress =
      await factory.getPair(
        tokenA,
        tokenB
      );

    if (
      pairAddress ===
      ethers.ZeroAddress
    ) {
      return null;
    }

    const pair =
      new ethers.Contract(
        pairAddress,
        pairAbi,
        provider
      );

    const reserves =
      await pair.getReserves();

    const token0 =
      await pair.token0();

    let reserveIn;
    let reserveOut;

    if (

      token0.toLowerCase() ===
      tokenA.toLowerCase()

    ) {

      reserveIn =
        BigInt(reserves[0]);

      reserveOut =
        BigInt(reserves[1]);

    } else {

      reserveIn =
        BigInt(reserves[1]);

      reserveOut =
        BigInt(reserves[0]);
    }

    return {

      pairAddress,

      reserveIn,

      reserveOut
    };

  } catch {

    return null;
  }
}

/* =========================================================
   REAL RESERVE DEPTH MODELING
========================================================= */

async function reserveBasedQuote(
  router,
  amount,
  path
) {

  try {

    let currentAmount =
      amount;

    for (
      let i = 0;
      i < path.length - 1;
      i++
    ) {

      const reserves =
        await getPairReserves(

          router,

          path[i],

          path[i + 1]
        );

      if (!reserves)
        return null;

      currentAmount =
        getAmountOut(

          currentAmount,

          reserves.reserveIn,

          reserves.reserveOut
        );
    }

    return currentAmount;

  } catch {

    return null;
  }
}

/* =========================================================
   VAULT BALANCE
========================================================= */

async function getVaultBalance() {

  const usdc =
    new ethers.Contract(
      USDC,
      erc20Abi,
      provider
    );

  return await usdc.balanceOf(
    CONTRACT_ADDRESS
  );
}

/* =========================================================
   MICRO DETECTION
========================================================= */

async function detectFastSpread(
  token
) {

  for (
    const buy
    of Object.values(routers)
  ) {

    for (
      const sell
      of Object.values(routers)
    ) {

      if (buy === sell)
        continue;

      for (
        const buyPath
        of buildBuyPaths(token)
      ) {

        const buyOut =
          await reserveBasedQuote(

            buy,

            MICRO_PROBE,

            buyPath
          );

        if (!buyOut)
          continue;

        for (
          const sellPath
          of buildSellPaths(token)
        ) {

          const sellOut =
            await reserveBasedQuote(

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

              buy,

              sell,

              buyPath,

              sellPath,

              profit
            };
          }
        }
      }
    }
  }

  return null;
}

/* =========================================================
   LIQUIDITY CURVE
========================================================= */

async function testLiquidityCurve(
  spread
) {

  console.log(
    "\n📊 Testing Liquidity Curve..."
  );

  const candidateSizes = [];

  let size =
    ethers.parseUnits(
      "0.02",
      6
    );

  for (
    let i = 0;
    i < 20;
    i++
  ) {

    candidateSizes.push(size);

    size = size * 2n;
  }

  let best = {

    amountIn: 0n,

    estimatedProfit: 0n,

    estimatedFinalUSDC: 0n
  };

  for (
    const testSize
    of candidateSizes
  ) {

    try {

      const buyOut =
        await reserveBasedQuote(

          spread.buy,

          testSize,

          spread.buyPath
        );

      if (!buyOut)
        continue;

      const finalOut =
        await reserveBasedQuote(

          spread.sell,

          buyOut,

          spread.sellPath
        );

      if (!finalOut)
        continue;

      const estimatedProfit =
        finalOut -
        testSize;

      console.log(

        `SIZE ${fmt(testSize)} → PROFIT ${fmt(estimatedProfit)}`
      );

      if (

        estimatedProfit >
        best.estimatedProfit

      ) {

        best = {

          amountIn:
            testSize,

          estimatedFinalUSDC:
            finalOut,

          estimatedProfit
        };
      }

      if (

        best.estimatedProfit > 0n &&

        estimatedProfit <
        best.estimatedProfit / 2n
      ) {

        break;
      }

    } catch {

      break;
    }
  }

  return best;
}

/* =========================================================
   FULL STATIC CHECK + REQUIRE DEBUG
========================================================= */

async function fullStaticCheck(
  signal
) {

  try {

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 120;

    pipeline(
      "STAGE 3.5",
      "FULL STATIC EXECUTION"
    );

    /*
    ESTIMATE GAS FIRST
    */

    try {

      const gas =
        await arb
        .executeAaveFlashLoanArbitrage
        .estimateGas(

          signal.route.buyRouter,

          signal.route.sellRouter,

          signal.size,

          signal.route.pathToToken,

          signal.route.pathToUSDC,

          deadline
        );

      console.log(
        `\n⛽ ESTIMATED GAS:\n${gas}`
      );

    } catch (gasErr) {

      console.log(
        "\n❌ GAS ESTIMATION FAILED"
      );

      console.log(
        gasErr.shortMessage ||
        gasErr.reason ||
        gasErr.message
      );
    }

    /*
    STATIC CALL
    */

    await arb
      .executeAaveFlashLoanArbitrage
      .staticCall(

        signal.route.buyRouter,

        signal.route.sellRouter,

        signal.size,

        signal.route.pathToToken,

        signal.route.pathToUSDC,

        deadline
      );

    console.log(
      "\n✅ FULL STATIC CALL PASSED"
    );

    return true;

  } catch (err) {

    console.log(
      "\n❌ STATIC CALL FAILED"
    );

    console.log(
      err.shortMessage ||
      err.reason ||
      err.message
    );

    /*
    REQUIRE DEBUGGING
    */

    const msg =
      (
        err.shortMessage ||
        err.reason ||
        err.message ||
        ""
      ).toLowerCase();

    if (
      msg.includes(
        "profit below minimum"
      )
    ) {

      console.log(
        "\n🧠 FAILED REQUIRE: Profit below minimum"
      );
    }

    else if (
      msg.includes(
        "flash loan unprofitable"
      )
    ) {

      console.log(
        "\n🧠 FAILED REQUIRE: Flash loan unprofitable"
      );
    }

    else if (
      msg.includes(
        "insufficient vault balance"
      )
    ) {

      console.log(
        "\n🧠 FAILED REQUIRE: Insufficient vault balance"
      );
    }

    else if (
      msg.includes(
        "invalid asset"
      )
    ) {

      console.log(
        "\n🧠 FAILED REQUIRE: Invalid asset"
      );
    }

    else if (
      msg.includes(
        "only aave pool"
      )
    ) {

      console.log(
        "\n🧠 FAILED REQUIRE: Only Aave Pool"
      );
    }

    else {

      console.log(
        "\n🧠 UNKNOWN REQUIRE FAILURE"
      );
    }

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

    if (EXECUTING)
      return null;

    console.log(
      `\n🔎 SCANNING ${name}`
    );

    const spread =
      await detectFastSpread(
        token
      );

    if (!spread)
      return null;

    console.log(
      "\n⚡ FAST MICRO SPREAD FOUND"
    );

    console.log(
      `\n📊 Micro Profit:\n${fmt(spread.profit)}`
    );

    pipeline(
      "STAGE 2",
      "DEPTH ANALYSIS"
    );

    const best =
      await testLiquidityCurve(
        spread
      );

    if (

      best.estimatedProfit <
      EXECUTION_THRESHOLD

    ) {

      return null;
    }

    console.log(
      "\n🏆 OPTIMAL DEPTH FOUND"
    );

    console.log(
      `\n📊 Contract Optimal Size:\n${fmt(best.amountIn)}`
    );

    console.log(
      `\n📊 Estimated Final:\n${fmt(best.estimatedFinalUSDC)}`
    );

    console.log(
      `\n📊 Estimated Profit:\n${fmt(best.estimatedProfit)}`
    );

    pipeline(
      "STAGE 3",
      "EXECUTION VALIDATION"
    );

    console.log(
      "\n✅ Execution precheck passed"
    );

    const signal = {

      route: {

        buyRouter:
          spread.buy,

        sellRouter:
          spread.sell,

        pathToToken:
          spread.buyPath,

        pathToUSDC:
          spread.sellPath
      },

      size:
        best.amountIn,

      profit:
        best.estimatedProfit
    };

    const staticPassed =
      await fullStaticCheck(
        signal
      );

    if (!staticPassed)
      return null;

    return signal;

  } catch (err) {

    console.log(
      "\n❌ DEPTH ANALYSIS ERROR"
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

    const tx =
      await arb
      .executeAaveFlashLoanArbitrage(

        signal.route.buyRouter,

        signal.route.sellRouter,

        signal.size,

        signal.route.pathToToken,

        signal.route.pathToUSDC,

        deadline,

        {
          gasLimit: 5000000
        }
      );

    console.log(
      `\n🚀 TX SENT:\n${tx.hash}`
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

    const realized =
      after > before
        ? after - before
        : 0n;

    console.log(
      `\n📈 REALIZED PROFIT:\n${fmt(realized)}`
    );

  } catch (err) {

    console.log(
      "\n❌ EXECUTION FAILED"
    );

    console.log(
      err.shortMessage ||
      err.reason ||
      err.message
    );
  }
}

/* =========================================================
   TASKS
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
    "\n🚀 RESERVE MODELER ENGINE STARTED"
  );

  const owner =
    await arb.owner();

  console.log(
    `\n👤 OWNER:\n${owner}`
  );

  console.log(
    `\n👤 WALLET:\n${wallet.address}`
  );

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

        if (!signal) {

          await sleep(
            LOOP_DELAY
          );

          continue;
        }

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

        EXECUTING = true;

        try {

          await execute(
            signal,
            task.name
          );

        } finally {

          EXECUTING = false;
        }

      } catch (err) {

        console.log(
          "\n❌ WORKER ERROR"
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
