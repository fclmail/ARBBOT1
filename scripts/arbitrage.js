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
  throw new Error("Missing private key");
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

provider.ens = null;

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

const QUICKSWAP =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHISWAP =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* =========================================================
   ABI
========================================================= */

const ABI = [

  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",

  "function getContractUSDCBalance() view returns(uint256)",

  "function withdraw(uint256)"
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

const TOKENS = [

  {
    symbol: "WETH",
    address:
      "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
  },

  {
    symbol: "WBTC",
    address:
      "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"
  },

  {
    symbol: "DAI",
    address:
      "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"
  },

  {
    symbol: "LINK",
    address:
      "0x53E0bca35ec356bd5dddfebbd1fc0fd03fabad39"
  },

  {
    symbol: "UNI",
    address:
      "0xb33EaAd8d922B1083446DC23f610c2567fB5180f"
  },

  {
    symbol: "SUSHI",
    address:
      "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a"
  },

  {
    symbol: "CRV",
    address:
      "0x172370d5Cd63279eFa6d502DAB29171933a610AF"
  }
];

/* =========================================================
   CANDIDATE FLASH SIZES
========================================================= */

const SIZES = [

  ethers.parseUnits("1000", 6),
  ethers.parseUnits("2500", 6),
  ethers.parseUnits("5000", 6),
  ethers.parseUnits("10000", 6),
  ethers.parseUnits("25000", 6),
  ethers.parseUnits("50000", 6),
  ethers.parseUnits("100000", 6)
];

/* =========================================================
   STATS
========================================================= */

let TOTAL_SCANS = 0;
let TOTAL_EXECUTIONS = 0;
let TOTAL_PROFIT = 0n;
let LAST_BLOCK = 0;

const queue = [];
let executing = false;

/* =========================================================
   BALANCE
========================================================= */

async function checkBalance() {

  try {

    const bal =
      await provider.call({
        to: USDC,
        data:
          "0x70a08231000000000000000000000000" +
          CONTRACT_ADDRESS
            .substring(2)
            .toLowerCase()
      });

    const decoded =
      ethers.toBigInt(bal);

    console.log(
      "CONTRACTUSDC:" +
      ethers.formatUnits(decoded, 6)
    );

    return decoded;

  } catch (e) {

    console.log(
      "BALANCEERROR:" +
      e.message.substring(0, 120)
    );

    return 0n;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(job) {

  try {

    executing = true;

    console.log("EXECMODE:FLASH");
    console.log("AAVECALLBACKSTART");

    const before =
      await checkBalance();

    const tx =
      await vault.executeBestFlashLoanArbitrage(

        QUICKSWAP,
        SUSHISWAP,

        SIZES,

        job.pathToToken,
        job.pathToUSDC,

        Math.floor(Date.now() / 1000) + 120
      );

    console.log(
      "TXHASH:" + tx.hash
    );

    const receipt =
      await tx.wait();

    LAST_BLOCK =
      receipt.blockNumber;

    console.log(
      "BLOCKCONFIRMED:" +
      receipt.blockNumber
    );

    const after =
      await checkBalance();

    const profit =
      after - before;

    if (profit > 0n) {

      TOTAL_PROFIT += profit;

      console.log(
        "NETPROFIT:" +
        ethers.formatUnits(profit, 6)
      );
    }

    TOTAL_EXECUTIONS++;

  } catch (e) {

    console.log(
      "EXECUTIONERROR:" +
      e.message.substring(0, 200)
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

    const job = queue.shift();

    await execute(job);
  }
}

/* =========================================================
   SCAN
========================================================= */

async function scanToken(token) {

  try {

    TOTAL_SCANS++;

    console.log("MICROSCANSTART");
    console.log("TOKEN:" + token.address);

    const pathToToken = [
      USDC,
      token.address
    ];

    const pathToUSDC = [
      token.address,
      USDC
    ];

    const result =
      await vault.findBestFlashLoanSize(

        QUICKSWAP,
        SUSHISWAP,

        SIZES,

        pathToToken,
        pathToUSDC
      );

    const size =
      BigInt(result.amountIn);

    const estimated =
      BigInt(
        result.estimatedProfit
      );

    console.log(
      "PROFITDENSITY:" +
      ethers.formatUnits(
        estimated,
        6
      )
    );

    if (estimated > 0n) {

      console.log(
        "PROFITABLEPATHFOUND"
      );

      console.log(
        "FINALCONTINUOUSSIZE:" +
        ethers.formatUnits(
          size,
          6
        )
      );

      enqueue({
        token: token.address,
        pathToToken,
        pathToUSDC
      });

    } else {

      console.log(
        "NOPROFIT"
      );
    }

  } catch (e) {

    console.log(
      "SCANERROR:" +
      e.message.substring(0, 200)
    );
  }
}

/* =========================================================
   LOOP
========================================================= */

async function scannerLoop() {

  while (true) {

    await Promise.all(
      TOKENS.map(scanToken)
    );

    await new Promise(
      r => setTimeout(r, 500)
    );
  }
}

/* =========================================================
   STATS
========================================================= */

function statsLoop() {

  setInterval(() => {

    console.log(
      "==============STATS=============="
    );

    console.log(
      "SCANS:" +
      TOTAL_SCANS
    );

    console.log(
      "EXECUTIONS:" +
      TOTAL_EXECUTIONS
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
      ethers.formatUnits(
        TOTAL_PROFIT,
        6
      )
    );

    console.log(
      "LASTBLOCK:" +
      LAST_BLOCK
    );

    console.log(
      "================================="
    );

  }, 5000);
}

/* =========================================================
   START
========================================================= */

async function start() {

  console.log(
    "ARBITRAGEBOTSTARTED"
  );

  console.log(
    "WALLET:" +
    wallet.address
  );

  console.log(
    "CONTRACT:" +
    CONTRACT_ADDRESS
  );

  await checkBalance();

  scannerLoop();

  statsLoop();
}

start();
