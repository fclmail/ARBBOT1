
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PK");
}

const RPC = "https://polygon-bor-rpc.publicnode.com";

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* =========================================================
   PROVIDER
========================================================= */

const provider = new ethers.JsonRpcProvider(RPC, {
  name: "polygon",
  chainId: 137,
  ensAddress: null
});

provider.ens = null;

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   CONTRACT
========================================================= */

const ABI = [
  "function findBestFlashLoanSize(address,uint256) view returns(uint256,uint256)",
  "function triggerFlashArbitrage((address,address,address),uint256,uint256)",
  "function startAaveFlashArbitrage(address,uint256,(address,address,address),uint256)",
  "function getContractUSDCBalance() view returns(uint256)",
  "function withdrawToken(address,uint256)"
];

const vault = new ethers.Contract(
  CONTRACT_ADDRESS,
  ABI,
  wallet
);

/* =========================================================
   TOKEN MAP
========================================================= */

const TOKEN_MAP = {
  // WETH
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {
    pair: "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  },

  // WMATIC
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": {
    pair: "0x6e7a5fafc77265b8e0cc57b4f7f8fbd7f6a5c1f6",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  },

  // DAI
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063": {
    pair: "0xf04adbf75cdfc5ed26eea4bbbb991db002036bdd",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  },

  // USDT
  "0xc2132D05D31c914a87C6611C10748AaCbC532Db": {
    pair: "0xc4e595acdd997d644b9e539e3e7f7f8f7f4c1f6",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  }
};

/* =========================================================
   POOLS
========================================================= */

const POOLS = Object.entries(TOKEN_MAP).map(
  ([token, config]) => ({
    token,
    config
  })
);

/* =========================================================
   GLOBALS
========================================================= */

const queue = [];

let executing = false;

let totalScans = 0;
let totalExecutions = 0;
let totalProfits = 0n;
let lastBlock = 0;

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUSDC(value) {
  try {
    return ethers.formatUnits(value, 6);
  } catch {
    return "0";
  }
}

/* =========================================================
   BALANCE CHECK
========================================================= */

async function checkContractBalance() {
  try {
    const usdcContract = new ethers.Contract(
      USDC,
      [
        "function balanceOf(address) view returns(uint256)"
      ],
      provider
    );

    const balance =
      await usdcContract.balanceOf(CONTRACT_ADDRESS);

    console.log(
      "CONTRACTUSDCBALANCE:" +
        formatUSDC(balance)
    );

    return balance;
  } catch (e) {
    console.log(
      "BALANCECHECKERROR:" +
        e.message.substring(0, 120)
    );

    return 0n;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(token, size, config) {
  try {
    console.log("------------------------------------------------");
    console.log("EXECMODE:FLASH");
    console.log("AAVECALLBACKSTART");

    const route = {
      routerBuy: config.routerBuy,
      routerSell: config.routerSell,
      token
    };

    const balanceBefore =
      await checkContractBalance();

    console.log(
      "BALANCEBEFORE:" +
        formatUSDC(balanceBefore)
    );

    console.log(
      "FLASHSIZE:" +
        formatUSDC(size)
    );

    const tx =
      await vault.startAaveFlashArbitrage(
        USDC,
        size,
        route,
        ethers.parseUnits("0.000001", 6)
      );

    console.log("TXHASH:" + tx.hash);

    const receipt = await tx.wait();

    console.log(
      "TXSTATUS:" + receipt.status
    );

    console.log(
      "BLOCKCONFIRMED:" +
        receipt.blockNumber
    );

    lastBlock = receipt.blockNumber;

    const balanceAfter =
      await checkContractBalance();

    console.log(
      "BALANCEAFTER:" +
        formatUSDC(balanceAfter)
    );

    const profit =
      balanceAfter - balanceBefore;

    if (profit > 0n) {
      totalProfits += profit;

      console.log(
        "NETPROFIT:" +
          formatUSDC(profit)
      );

      console.log(
        "TOTALPROFIT:" +
          formatUSDC(totalProfits)
      );

      console.log(
        "PROFITCAPTURED"
      );

      // OPTIONAL AUTO WITHDRAW
      if (
        profit >
        ethers.parseUnits("100", 6)
      ) {
        try {
          console.log(
            "WITHDRAWINGPROFIT"
          );

          const withdrawTx =
            await vault.withdrawToken(
              USDC,
              profit
            );

          console.log(
            "WITHDRAWHASH:" +
              withdrawTx.hash
          );

          await withdrawTx.wait();

          console.log(
            "PROFITWITHDRAWN"
          );
        } catch (e) {
          console.log(
            "WITHDRAWERROR:" +
              e.message.substring(0, 120)
          );
        }
      }
    } else {
      console.log(
        "NOREALIZEDPROFIT"
      );
    }

    totalExecutions++;

    console.log(
      "EXECUTIONCOMPLETE"
    );

    console.log("------------------------------------------------");
  } catch (e) {
    console.log(
      "EXECERROR:" +
        e.message.substring(0, 200)
    );
  }
}

/* =========================================================
   QUEUE
========================================================= */

function enqueue(job) {
  queue.push(job);

  console.log(
    "QUEUEADD:" +
      queue.length
  );

  processQueue();
}

async function processQueue() {
  if (executing) {
    return;
  }

  executing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      await execute(
        job.token,
        job.size,
        job.config
      );
    } catch (e) {
      console.log(
        "QUEUEEXECERROR:" +
          e.message.substring(0, 120)
      );
    }
  }

  executing = false;
}

/* =========================================================
   SCANNER
========================================================= */

async function scanPool(pool) {
  try {
    totalScans++;

    console.log("MICROSCANSTART");

    const maxLoan =
      ethers.parseUnits("100000", 6);

    /* =====================================================
       IMPORTANT FIX:
       USE TOKEN ADDRESS NOT PAIR ADDRESS
    ===================================================== */

    const depth =
      await vault.findBestFlashLoanSize(
        pool.token,
        maxLoan
      );

    const optimalSize =
      BigInt(depth[0]);

    const profit =
      BigInt(depth[1]);

    console.log(
      "TOKEN:" +
        pool.token.substring(0, 10) +
        "..."
    );

    console.log(
      "MICROPROFIT:" +
        formatUSDC(profit)
    );

    console.log(
      "FINDINGOPTIMALFLASHLOANSIZE"
    );

    console.log(
      "CONTRACTSIZE:" +
        formatUSDC(optimalSize)
    );

    if (optimalSize > 0n) {
      const density =
        profit * 1000000n /
        optimalSize;

      console.log(
        "PROFITDENSITY:" +
          density.toString()
      );
    }

    console.log(
      "FINALCONTINUOUSSIZE:" +
        formatUSDC(optimalSize)
    );

    if (
      profit > 0n &&
      optimalSize > 0n
    ) {
      console.log(
        "PROFITABLEOPPORTUNITYFOUND"
      );

      enqueue({
        token: pool.token,
        size: optimalSize,
        config: pool.config
      });
    } else {
      console.log(
        "NOPROFITFOUND"
      );
    }
  } catch (e) {
    console.log(
      "SCANERROR:" +
        e.message.substring(0, 150)
    );
  }
}

/* =========================================================
   SCANNER LOOP
========================================================= */

async function scannerLoop() {
  console.log("SCANNERSTARTED");

  while (true) {
    try {
      await Promise.all(
        POOLS.map(scanPool)
      );
    } catch (e) {
      console.log(
        "LOOPERROR:" +
          e.message.substring(0, 120)
      );
    }

    await sleep(500);
  }
}

/* =========================================================
   MONITOR
========================================================= */

function monitor() {
  setInterval(() => {
    console.log("==============STATS==============");

    console.log(
      "QUEUE:" + queue.length
    );

    console.log(
      "EXECUTING:" + executing
    );

    console.log(
      "TOTALSCANS:" + totalScans
    );

    console.log(
      "TOTALEXECUTIONS:" +
        totalExecutions
    );

    console.log(
      "TOTALPROFITS:" +
        formatUSDC(totalProfits)
    );

    console.log(
      "LASTBLOCK:" +
        lastBlock
    );

    console.log("=================================");
  }, 2000);
}

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    console.log("=================================");
    console.log("ARBITRAGEBOTSTARTED");
    console.log("FLASHLOANMODE:AAVE");
    console.log("NETWORK:POLYGON");
    console.log("WALLET:" + wallet.address);
    console.log("CONTRACT:" + CONTRACT_ADDRESS);
    console.log(
      "TOKENS:" + POOLS.length
    );
    console.log("=================================");

    await checkContractBalance();

    scannerLoop();

    monitor();
  } catch (e) {
    console.log(
      "STARTERROR:" +
        e.message.substring(0, 120)
    );
  }
}

start();
