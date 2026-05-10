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
  throw new Error("Missing PK");
}

const RPC =
  "https://polygon-bor-rpc.publicnode.com";

const provider =
  new ethers.JsonRpcProvider(
    RPC,
    {
      name: "polygon",
      chainId: 137,
      ensAddress: null
    }
  );

/* =========================================================
   FULL ENS DISABLE
========================================================= */

provider.ens = null;

provider.resolveName =
  async (name) => name;

/* =========================================================
   WALLET
========================================================= */

const wallet =
  new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* =========================================================
   ROUTERS
========================================================= */

const QUICKSWAP =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHISWAP =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const APESWAP =
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607";

/* =========================================================
   ABI
========================================================= */

const ABI = [

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",

  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",

  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256)",

  "function withdraw(uint256)",

  "function minimumProfitUSDC() view returns(uint256)"
];

const vault =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    ABI,
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
    "0xc2132D05D31c914a87C6611C10748AaCbC532Db",

  WBTC:
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",

  LINK:
    "0x53E0bca35eC356BD5ddDFebbD1Fc0fFAeD03c9",

  AAVE:
    "0xD6DF932A45C0f255f85145f286ea0B292B21C90B",

  CRV:
    "0x172370d5Cd63279eFa6d502DAB29171933a610AF",

  UNI:
    "0xb33EaAd8d922B1083446DC23f610c2567fB5180f"
};

/* =========================================================
   MULTI HOP PATHS
========================================================= */

const STRATEGIES = [

  /* =====================================================
     WETH
  ===================================================== */

  {
    token: TOKENS.WETH,

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

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
  },

  {
    token: TOKENS.WETH,

    buyRouter: SUSHISWAP,
    sellRouter: QUICKSWAP,

    pathToToken: [
      USDC,
      TOKENS.WETH
    ],

    pathToUSDC: [
      TOKENS.WETH,
      USDC
    ]
  },

  /* =====================================================
     WBTC
  ===================================================== */

  {
    token: TOKENS.WBTC,

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

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
  },

  /* =====================================================
     LINK
  ===================================================== */

  {
    token: TOKENS.LINK,

    buyRouter: QUICKSWAP,
    sellRouter: APESWAP,

    pathToToken: [
      USDC,
      TOKENS.WMATIC,
      TOKENS.LINK
    ],

    pathToUSDC: [
      TOKENS.LINK,
      TOKENS.WMATIC,
      USDC
    ]
  },

  /* =====================================================
     DAI
  ===================================================== */

  {
    token: TOKENS.DAI,

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      TOKENS.DAI
    ],

    pathToUSDC: [
      TOKENS.DAI,
      USDC
    ]
  },

  /* =====================================================
     UNI
  ===================================================== */

  {
    token: TOKENS.UNI,

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      TOKENS.WETH,
      TOKENS.UNI
    ],

    pathToUSDC: [
      TOKENS.UNI,
      TOKENS.WETH,
      USDC
    ]
  },

  /* =====================================================
     AAVE
  ===================================================== */

  {
    token: TOKENS.AAVE,

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      TOKENS.WETH,
      TOKENS.AAVE
    ],

    pathToUSDC: [
      TOKENS.AAVE,
      TOKENS.WETH,
      USDC
    ]
  },

  /* =====================================================
     CRV
  ===================================================== */

  {
    token: TOKENS.CRV,

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      TOKENS.WMATIC,
      TOKENS.CRV
    ],

    pathToUSDC: [
      TOKENS.CRV,
      TOKENS.WMATIC,
      USDC
    ]
  }
];

/* =========================================================
   CANDIDATE FLASH SIZES
========================================================= */

const CANDIDATE_SIZES = [

  ethers.parseUnits("100", 6),
  ethers.parseUnits("250", 6),
  ethers.parseUnits("500", 6),
  ethers.parseUnits("1000", 6),
  ethers.parseUnits("2500", 6),
  ethers.parseUnits("5000", 6),
  ethers.parseUnits("10000", 6),
  ethers.parseUnits("25000", 6),
  ethers.parseUnits("50000", 6),
  ethers.parseUnits("100000", 6)
];

/* =========================================================
   GLOBALS
========================================================= */

let executing = false;

let totalScans = 0;

let totalExecutions = 0;

let totalProfit = 0n;

const queue = [];

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function usdc(n) {
  return ethers.formatUnits(n, 6);
}

/* =========================================================
   BALANCE
========================================================= */

async function contractBalance() {

  try {

    const token =
      new ethers.Contract(
        USDC,
        [
          "function balanceOf(address) view returns(uint256)"
        ],
        provider
      );

    return await token.balanceOf(
      CONTRACT_ADDRESS
    );

  } catch {

    return 0n;
  }
}

/* =========================================================
   EXECUTE
========================================================= */

async function execute(strategy, size) {

  try {

    executing = true;

    console.log(
      "================================="
    );

    console.log(
      "FLASHLOANEXECUTIONSTART"
    );

    console.log(
      "TOKEN:" +
      strategy.token
    );

    console.log(
      "SIZE:" +
      usdc(size)
    );

    const before =
      await contractBalance();

    console.log(
      "BALANCEBEFORE:" +
      usdc(before)
    );

    const deadline =
      Math.floor(Date.now() / 1000) +
      120;

    const tx =
      await vault.executeAaveFlashLoanArbitrage(

        strategy.buyRouter,

        strategy.sellRouter,

        size,

        strategy.pathToToken,

        strategy.pathToUSDC,

        deadline
      );

    console.log(
      "TXHASH:" + tx.hash
    );

    const receipt =
      await tx.wait();

    console.log(
      "BLOCKCONFIRMED:" +
      receipt.blockNumber
    );

    const after =
      await contractBalance();

    console.log(
      "BALANCEAFTER:" +
      usdc(after)
    );

    const profit =
      after - before;

    if (profit > 0n) {

      totalProfit += profit;

      console.log(
        "NETPROFIT:" +
        usdc(profit)
      );

      console.log(
        "TOTALPROFIT:" +
        usdc(totalProfit)
      );

    } else {

      console.log(
        "NOREALIZEDPROFIT"
      );
    }

    totalExecutions++;

    console.log(
      "EXECUTIONS:" +
      totalExecutions
    );

    console.log(
      "FLASHLOANEXECUTIONEND"
    );

    console.log(
      "================================="
    );

  } catch (e) {

    console.log(
      "EXECUTIONERROR:" +
      e.message.substring(0, 300)
    );

  } finally {

    executing = false;
  }
}

/* =========================================================
   QUEUE
========================================================= */

function enqueue(job) {

  queue.push(job);

  processQueue();
}

async function processQueue() {

  if (executing) {
    return;
  }

  while (queue.length > 0) {

    const job =
      queue.shift();

    await execute(
      job.strategy,
      job.size
    );
  }
}

/* =========================================================
   SCANNER
========================================================= */

async function scanStrategy(strategy) {

  try {

    totalScans++;

    console.log(
      "MICROSCANSTART"
    );

    console.log(
      "TOKEN:" +
      strategy.token
    );

    const result =
      await vault.findBestFlashLoanSize(

        strategy.buyRouter,

        strategy.sellRouter,

        CANDIDATE_SIZES,

        strategy.pathToToken,

        strategy.pathToUSDC
      );

    const size =
      BigInt(result.amountIn);

    const finalUSDC =
      BigInt(
        result.estimatedFinalUSDC
      );

    const profit =
      BigInt(
        result.estimatedProfit
      );

    console.log(
      "MICROPROFIT:" +
      usdc(profit)
    );

    console.log(
      "FINALUSDC:" +
      usdc(finalUSDC)
    );

    console.log(
      "OPTIMALSIZE:" +
      usdc(size)
    );

    if (
      profit > 0n &&
      size > 0n
    ) {

      console.log(
        "PROFITABLEOPPORTUNITYFOUND"
      );

      enqueue({
        strategy,
        size
      });

    } else {

      console.log(
        "NOPROFITFOUND"
      );
    }

  } catch (e) {

    console.log(
      "SCANERROR:" +
      e.message.substring(0, 250)
    );
  }
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function scannerLoop() {

  console.log(
    "MULTIHOPSCANNERSTARTED"
  );

  while (true) {

    try {

      await Promise.all(
        STRATEGIES.map(
          scanStrategy
        )
      );

    } catch (e) {

      console.log(
        "LOOPERROR:" +
        e.message.substring(0, 200)
      );
    }

    await sleep(800);
  }
}

/* =========================================================
   MONITOR
========================================================= */

function monitor() {

  setInterval(() => {

    console.log(
      "==============STATS=============="
    );

    console.log(
      "SCANS:" +
      totalScans
    );

    console.log(
      "EXECUTIONS:" +
      totalExecutions
    );

    console.log(
      "QUEUE:" +
      queue.length
    );

    console.log(
      "EXECUTING:" +
      executing
    );

    console.log(
      "TOTALPROFIT:" +
      usdc(totalProfit)
    );

    console.log(
      "================================="
    );

  }, 3000);
}

/* =========================================================
   START
========================================================= */

async function start() {

  console.log(
    "================================="
  );

  console.log(
    "ARBBOTSTARTED"
  );

  console.log(
    "MODE:MULTIHOPFLASH"
  );

  console.log(
    "NETWORK:POLYGON"
  );

  console.log(
    "WALLET:" +
    wallet.address
  );

  console.log(
    "CONTRACT:" +
    CONTRACT_ADDRESS
  );

  console.log(
    "STRATEGIES:" +
    STRATEGIES.length
  );

  console.log(
    "================================="
  );

  const minimum =
    await vault.minimumProfitUSDC();

  console.log(
    "MINIMUMPROFIT:" +
    usdc(minimum)
  );

  scannerLoop();

  monitor();
}

start();
