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
  new ethers.JsonRpcProvider(RPC, {
    name: "polygon",
    chainId: 137
  });

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

const WETH =
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const WMATIC =
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const WBTC =
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";

const DAI =
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";

const CRV =
  "0x172370d5Cd63279eFa6d502DAB29171933a610AF";

/* =========================================================
   ROUTERS
========================================================= */

const QUICKSWAP =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHISWAP =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* =========================================================
   ABI
========================================================= */

const ABI = [
  "function owner() view returns(address)",

  "function minimumProfitUSDC() view returns(uint256)",

  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256)",

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",

  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",

  "function withdraw(uint256)"
];

const vault =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    ABI,
    wallet
  );

/* =========================================================
   TOKEN CONFIG
========================================================= */

const TOKEN_MAP = {
  [WETH]: {
    symbol: "WETH",

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      WETH
    ],

    pathToUSDC: [
      WETH,
      USDC
    ]
  },

  [WBTC]: {
    symbol: "WBTC",

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      WETH,
      WBTC
    ],

    pathToUSDC: [
      WBTC,
      WETH,
      USDC
    ]
  },

  [DAI]: {
    symbol: "DAI",

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      DAI
    ],

    pathToUSDC: [
      DAI,
      USDC
    ]
  },

  [CRV]: {
    symbol: "CRV",

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      WETH,
      CRV
    ],

    pathToUSDC: [
      CRV,
      WETH,
      USDC
    ]
  },

  [WMATIC]: {
    symbol: "WMATIC",

    buyRouter: QUICKSWAP,
    sellRouter: SUSHISWAP,

    pathToToken: [
      USDC,
      WMATIC
    ],

    pathToUSDC: [
      WMATIC,
      USDC
    ]
  }
};

const POOLS =
  Object.entries(TOKEN_MAP).map(
    ([token, cfg]) => ({
      token,
      config: cfg
    })
  );

/* =========================================================
   QUEUE
========================================================= */

const queue = [];

let executing = false;

/* =========================================================
   ERC20
========================================================= */

const usdcContract =
  new ethers.Contract(
    USDC,
    [
      "function balanceOf(address) view returns(uint256)"
    ],
    provider
  );

/* =========================================================
   VERIFY
========================================================= */

async function verifyContract() {

  console.log("VERIFYINGCONTRACT");

  try {

    const code =
      await provider.getCode(
        CONTRACT_ADDRESS
      );

    if (code === "0x") {

      console.log(
        "NOCONTRACTFOUND"
      );

      return false;
    }

    console.log(
      "CONTRACTFOUND"
    );

    const owner =
      await vault.owner();

    console.log(
      "OWNER:" + owner
    );

    console.log(
      "WALLET:" +
      wallet.address
    );

    if (
      owner.toLowerCase() !==
      wallet.address.toLowerCase()
    ) {

      console.log(
        "WARNINGNOTOWNER"
      );
    }

    console.log(
      "CONTRACTVERIFIED"
    );

    return true;

  } catch (e) {

    console.log(
      "VERIFYERROR:" +
      e.message.substring(0, 150)
    );

    return false;
  }
}

/* =========================================================
   BALANCE
========================================================= */

async function checkContractBalance() {

  try {

    const balance =
      await usdcContract.balanceOf(
        CONTRACT_ADDRESS
      );

    console.log(
      "CONTRACTUSDCBALANCE:" +
      ethers.formatUnits(
        balance,
        6
      )
    );

    return balance;

  } catch (e) {

    console.log(
      "BALANCECHECKERROR:" +
      e.message.substring(0, 150)
    );

    return 0n;
  }
}

/* =========================================================
   EXECUTE
========================================================= */

async function execute(
  token,
  size,
  config
) {

  console.log(
    "EXECMODE:FLASH"
  );

  console.log(
    "AAVECALLBACKSTART"
  );

  const before =
    await checkContractBalance();

  console.log(
    "BALANCEBEFORE:" +
    ethers.formatUnits(
      before,
      6
    )
  );

  try {

    const deadline =
      Math.floor(
        Date.now() / 1000
      ) + 120;

    const tx =
      await vault.executeAaveFlashLoanArbitrage(
        config.buyRouter,
        config.sellRouter,
        size,
        config.pathToToken,
        config.pathToUSDC,
        deadline
      );

    console.log(
      "TXHASH:" +
      tx.hash
    );

    const receipt =
      await tx.wait();

    console.log(
      "TXSTATUS:" +
      receipt.status
    );

    if (receipt.status === 1) {

      const after =
        await checkContractBalance();

      console.log(
        "BALANCEAFTER:" +
        ethers.formatUnits(
          after,
          6
        )
      );

      const profit =
        after - before;

      if (profit > 0n) {

        console.log(
          "NETPROFIT:" +
          ethers.formatUnits(
            profit,
            6
          )
        );

        console.log(
          "BLOCKCONFIRMED:" +
          receipt.blockNumber
        );

      } else {

        console.log(
          "NOPROFIT"
        );
      }
    }

    return receipt.blockNumber;

  } catch (e) {

    console.log(
      "EXECERROR:" +
      e.message.substring(0, 300)
    );

    return null;
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

  if (executing) return;

  executing = true;

  while (
    queue.length > 0
  ) {

    const job =
      queue.shift();

    console.log(
      "QUEUEEXECUTE:" +
      job.config.symbol
    );

    try {

      await execute(
        job.token,
        job.size,
        job.config
      );

    } catch (e) {

      console.log(
        "QUEUEERROR:" +
        e.message.substring(0, 150)
      );
    }
  }

  executing = false;
}

/* =========================================================
   SCAN
========================================================= */

async function scanPool(pool) {

  try {

    console.log(
      "MICROSCANSTART"
    );

    console.log(
      "SCANNINGTOKEN:" +
      pool.config.symbol
    );

    const candidateSizes = [

      ethers.parseUnits(
        "1000",
        6
      ),

      ethers.parseUnits(
        "5000",
        6
      ),

      ethers.parseUnits(
        "10000",
        6
      ),

      ethers.parseUnits(
        "25000",
        6
      ),

      ethers.parseUnits(
        "50000",
        6
      )
    ];

    const result =
      await vault.findBestFlashLoanSize(
        pool.config.buyRouter,
        pool.config.sellRouter,
        candidateSizes,
        pool.config.pathToToken,
        pool.config.pathToUSDC
      );

    const optimalSize =
      BigInt(result.amountIn);

    const profit =
      BigInt(
        result.estimatedProfit
      );

    console.log(
      "MICROPROFIT:" +
      ethers.formatUnits(
        profit,
        6
      )
    );

    console.log(
      "CONTRACTSIZE:" +
      ethers.formatUnits(
        optimalSize,
        6
      )
    );

    const density =
      optimalSize > 0n
        ? Number(
            (
              Number(profit) /
              Number(optimalSize)
            ).toFixed(8)
          )
        : 0;

    console.log(
      "PROFITDENSITY:" +
      density
    );

    if (
      profit > 0n
    ) {

      console.log(
        "OPPORTUNITYFOUND"
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
      e.message.substring(0, 250)
    );
  }
}

/* =========================================================
   RETRY
========================================================= */

async function scanPoolWithRetry(
  pool,
  maxRetries = 3
) {

  for (
    let attempt = 1;
    attempt <= maxRetries;
    attempt++
  ) {

    try {

      await scanPool(pool);

      return;

    } catch (e) {

      console.log(
        "RETRY:" +
        attempt +
        "/" +
        maxRetries
      );

      await new Promise(
        (r) =>
          setTimeout(r, 1000)
      );
    }
  }

  console.log(
    "MAXRETRIESFAILED"
  );
}

/* =========================================================
   SCANNER
========================================================= */

async function scannerLoop() {

  console.log(
    "SCANNERSTARTED"
  );

  let cycle = 0;

  while (true) {

    cycle++;

    console.log(
      "SCANCYCLE:" +
      cycle
    );

    await Promise.all(
      POOLS.map(
        scanPoolWithRetry
      )
    );

    console.log(
      "QUEUEDEPTH:" +
      queue.length
    );

    await new Promise(
      (r) =>
        setTimeout(r, 2000)
    );
  }
}

/* =========================================================
   MONITOR
========================================================= */

function monitor() {

  setInterval(
    async () => {

      const balance =
        await checkContractBalance();

      console.log(
        "QUEUE:" +
        queue.length +
        " EXEC:" +
        executing +
        " BALANCE:" +
        ethers.formatUnits(
          balance,
          6
        )
      );

    },
    5000
  );
}

/* =========================================================
   DIAGNOSTICS
========================================================= */

async function diagnostics() {

  console.log(
    "DIAGNOSTICSTART"
  );

  try {

    const testPool =
      POOLS[0];

    const candidateSizes = [
      ethers.parseUnits(
        "1000",
        6
      ),
      ethers.parseUnits(
        "5000",
        6
      )
    ];

    console.log(
      "TESTINGFINDBESTFLASHLOANSIZE"
    );

    const result =
      await vault.findBestFlashLoanSize(
        testPool.config.buyRouter,
        testPool.config.sellRouter,
        candidateSizes,
        testPool.config.pathToToken,
        testPool.config.pathToUSDC
      );

    console.log(
      "TESTOPTIMALSIZE:" +
      ethers.formatUnits(
        result.amountIn,
        6
      )
    );

    console.log(
      "TESTPROFIT:" +
      ethers.formatUnits(
        result.estimatedProfit,
        6
      )
    );

  } catch (e) {

    console.log(
      "DIAGNOSTICERROR:" +
      e.message.substring(0, 200)
    );
  }

  console.log(
    "DIAGNOSTICCOMPLETE"
  );
}

/* =========================================================
   START
========================================================= */

async function start() {

  console.log(
    "========================================"
  );

  console.log(
    "ARBBOTSTARTED"
  );

  console.log(
    "========================================"
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
    "USDC:" +
    USDC
  );

  console.log(
    "TOTALPOOLS:" +
    POOLS.length
  );

  console.log(
    "========================================"
  );

  const verified =
    await verifyContract();

  if (!verified) {

    console.log(
      "WARNINGCONTRACTNOTVALID"
    );
  }

  await diagnostics();

  const initialBalance =
    await checkContractBalance();

  console.log(
    "INITIALBALANCE:" +
    ethers.formatUnits(
      initialBalance,
      6
    )
  );

  scannerLoop();

  monitor();

  console.log(
    "ALLSERVICESSTARTED"
  );
}

/* =========================================================
   RUN
========================================================= */

start().catch((error) => {

  console.error(
    "FATALERROR:",
    error
  );

  console.error(
    error.stack
  );

  process.exit(1);
});
