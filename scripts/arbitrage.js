import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing private key");
}

const RPC = "https://polygon-bor-rpc.publicnode.com";

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC, {
  name: "polygon",
  chainId: 137
});

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const ABI = [
  "function findBestFlashLoanSize(address,uint256) view returns(uint256,uint256)",
  "function triggerFlashArbitrage((address,address,address),uint256,uint256)",
  "function startAaveFlashArbitrage(address,uint256,(address,address,address),uint256)",
  "function getContractUSDCBalance() view returns(uint256)",
  "function withdrawToken(address,uint256)",
  "function owner() view returns(address)",
  "function usdcToken() view returns(address)"
];

const vault = new ethers.Contract(
  CONTRACT_ADDRESS,
  ABI,
  wallet
);

/* ================= TOKEN CONFIG ================= */

const TOKEN_MAP = {
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {
    pair: "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  }
};

/* ================= POOLS ================= */

const POOLS = Object.entries(TOKEN_MAP).map(
  ([token, cfg]) => ({
    token,
    config: cfg
  })
);

/* ================= QUEUE ================= */

const queue = [];
let executing = false;

/* ================= VERIFY CONTRACT ================= */

async function verifyContract() {
  console.log("VERIFYINGCONTRACT");

  try {
    const code = await provider.getCode(CONTRACT_ADDRESS);

    if (code === "0x") {
      console.log("NOCONTRACTFOUND");
      return false;
    }

    console.log("CONTRACTFOUND");

    try {
      const owner = await vault.owner();

      console.log("OWNER:" + owner);
      console.log("WALLET:" + wallet.address);

      if (
        owner.toLowerCase() !==
        wallet.address.toLowerCase()
      ) {
        console.log("WARNINGNOTOWNER");
      }
    } catch {
      console.log("OWNERFUNCTIONFAILED");
    }

    try {
      const contractUSDC =
        await vault.usdcToken();

      console.log("CONTRACTUSDC:" + contractUSDC);

      if (
        contractUSDC.toLowerCase() !==
        USDC.toLowerCase()
      ) {
        console.log("USDCMISMATCH");
      }
    } catch {
      console.log("USDCCHECKFAILED");
    }

    console.log("CONTRACTVERIFIED");

    return true;
  } catch (e) {
    console.log(
      "VERIFYERROR:" +
        e.message.substring(0, 120)
    );

    return false;
  }
}

/* ================= BALANCE CHECK ================= */

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
      await usdcContract.balanceOf(
        CONTRACT_ADDRESS
      );

    console.log(
      "CONTRACTUSDCBALANCE:" +
        ethers.formatUnits(balance, 6)
    );

    return balance;
  } catch (e) {
    console.log(
      "BALANCECHECKERROR:" +
        e.message.substring(0, 100)
    );

    return 0n;
  }
}

/* ================= EXECUTE ================= */

async function execute(
  token,
  size,
  config
) {
  const route = {
    routerBuy: config.routerBuy,
    routerSell: config.routerSell,
    token
  };

  console.log("EXECMODE:FLASH");
  console.log("AAVECALLBACKSTART");

  const balanceBefore =
    await checkContractBalance();

  console.log(
    "BALANCEBEFORE:" +
      ethers.formatUnits(balanceBefore, 6)
  );

  try {
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

    if (receipt.status === 1) {
      const balanceAfter =
        await checkContractBalance();

      console.log(
        "BALANCEAFTER:" +
          ethers.formatUnits(
            balanceAfter,
            6
          )
      );

      const profit =
        balanceAfter - balanceBefore;

      if (profit > 0n) {
        console.log(
          "NETPROFIT:" +
            ethers.formatUnits(profit, 6)
        );

        console.log(
          "BLOCKCONFIRMED:" +
            receipt.blockNumber
        );

        const withdrawalThreshold =
          ethers.parseUnits("100", 6);

        if (
          profit >= withdrawalThreshold
        ) {
          try {
            const withdrawTx =
              await vault.withdrawToken(
                USDC,
                profit
              );

            await withdrawTx.wait();

            console.log(
              "PROFITWITHDRAWN:" +
                ethers.formatUnits(
                  profit,
                  6
                )
            );
          } catch (withdrawError) {
            console.log(
              "WITHDRAWERROR:" +
                withdrawError.message.substring(
                  0,
                  120
                )
            );
          }
        }
      } else {
        console.log("NOPROFIT");
      }
    }

    return receipt.blockNumber;
  } catch (e) {
    console.log(
      "EXECERROR:" +
        e.message.substring(0, 200)
    );

    return null;
  }
}

/* ================= QUEUE ================= */

function enqueue(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (executing) return;

  executing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    console.log(
      "QUEUEEXECUTE:" +
        job.token.substring(0, 10)
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
          e.message.substring(0, 120)
      );
    }
  }

  executing = false;
}

/* ================= SCAN POOL ================= */

async function scanPool(pool) {
  try {
    console.log("MICROSCANSTART");

    const maxLoan =
      ethers.parseUnits("100000", 6);

    console.log(
      "SCANNINGTOKEN:" +
        pool.token.substring(0, 10)
    );

    let depth;

    try {
      depth =
        await vault.findBestFlashLoanSize(
          pool.token,
          maxLoan
        );

      console.log("SCANMETHOD:TOKEN");
    } catch {
      try {
        depth =
          await vault.findBestFlashLoanSize(
            pool.config.pair,
            maxLoan
          );

        console.log("SCANMETHOD:PAIR");
      } catch {
        const smallLoan =
          ethers.parseUnits("10000", 6);

        depth =
          await vault.findBestFlashLoanSize(
            pool.token,
            smallLoan
          );

        console.log(
          "SCANMETHOD:SMALLLOAN"
        );
      }
    }

    const optimalSize = BigInt(depth[0]);
    const profit = BigInt(depth[1]);

    console.log(
      "MICROPROFIT:" +
        ethers.formatUnits(profit, 6)
    );

    console.log(
      "FINDINGOPTIMALFLASHLOANSIZE"
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
      "PROFITDENSITY:" + density
    );

    console.log(
      "FINALCONTINUOUSSIZE:" +
        ethers.formatUnits(
          optimalSize,
          6
        )
    );

    if (profit > 0n) {
      console.log("OPPORTUNITYFOUND");

      enqueue({
        token: pool.token,
        size: optimalSize,
        config: pool.config
      });
    } else {
      console.log("NOPROFITFOUND");
    }
  } catch (e) {
    console.log(
      "SCANERROR:" +
        e.message.substring(0, 200)
    );
  }
}

/* ================= RETRY ================= */

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

      if (attempt < maxRetries) {
        await new Promise((r) =>
          setTimeout(r, 1000)
        );
      } else {
        console.log("MAXRETRIESFAILED");
      }
    }
  }
}

/* ================= SCANNER LOOP ================= */

async function scannerLoop() {
  console.log("SCANNERSTARTED");

  let cycle = 0;

  while (true) {
    cycle++;

    console.log(
      "SCANCYCLE:" + cycle
    );

    await Promise.all(
      POOLS.map(scanPoolWithRetry)
    );

    console.log(
      "QUEUEDEPTH:" + queue.length
    );

    await new Promise((r) =>
      setTimeout(r, 2000)
    );
  }
}

/* ================= MONITOR ================= */

function monitor() {
  setInterval(async () => {
    const balance =
      await checkContractBalance();

    console.log(
      "QUEUE:" +
        queue.length +
        " EXEC:" +
        executing +
        " BALANCE:" +
        ethers.formatUnits(balance, 6)
    );
  }, 5000);
}

/* ================= SCHEDULED WITHDRAWAL ================= */

function scheduledProfitWithdrawal() {
  setInterval(async () => {
    try {
      const balance =
        await checkContractBalance();

      const threshold =
        ethers.parseUnits("500", 6);

      if (balance >= threshold) {
        console.log(
          "SCHEDULEDWITHDRAWALSTART"
        );

        const keepInContract =
          ethers.parseUnits("50", 6);

        const withdrawAmount =
          balance - keepInContract;

        if (withdrawAmount > 0n) {
          const tx =
            await vault.withdrawToken(
              USDC,
              withdrawAmount
            );

          await tx.wait();

          console.log(
            "SCHEDULEDWITHDRAWALCOMPLETE:" +
              ethers.formatUnits(
                withdrawAmount,
                6
              )
          );
        }
      }
    } catch (e) {
      console.log(
        "SCHEDULEDWITHDRAWALERROR:" +
          e.message.substring(0, 120)
      );
    }
  }, 1800000);
}

/* ================= TEST FUNCTIONS ================= */

async function testContractFunctions() {
  console.log("DIAGNOSTICSTART");

  try {
    const testBalance =
      await vault.getContractUSDCBalance();

    console.log(
      "GETBALANCEWORKS:" +
        ethers.formatUnits(
          testBalance,
          6
        )
    );
  } catch (e) {
    console.log(
      "GETBALANCEFAILED:" +
        e.message.substring(0, 120)
    );
  }

  try {
    const tinyLoan =
      ethers.parseUnits("100", 6);

    const testToken =
      Object.keys(TOKEN_MAP)[0];

    console.log(
      "TESTINGFINDBESTFLASHLOANSIZE"
    );

    const result =
      await vault.findBestFlashLoanSize(
        testToken,
        tinyLoan
      );

    console.log(
      "TESTOPTIMALSIZE:" +
        ethers.formatUnits(
          result[0],
          6
        )
    );

    console.log(
      "TESTPROFIT:" +
        ethers.formatUnits(
          result[1],
          6
        )
    );
  } catch (e) {
    console.log(
      "FINDBESTFLASHFAILED:" +
        e.message.substring(0, 120)
    );
  }

  console.log("DIAGNOSTICCOMPLETE");
}

/* ================= START ================= */

async function start() {
  console.log(
    "========================================"
  );

  console.log("ARBBOTSTARTED");

  console.log(
    "========================================"
  );

  console.log(
    "WALLET:" + wallet.address
  );

  console.log(
    "CONTRACT:" + CONTRACT_ADDRESS
  );

  console.log("USDC:" + USDC);

  console.log(
    "TOTALPOOLS:" + POOLS.length
  );

  console.log(
    "========================================"
  );

  const contractValid =
    await verifyContract();

  if (!contractValid) {
    console.log(
      "WARNINGCONTRACTNOTVALID"
    );
  }

  await testContractFunctions();

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

  scheduledProfitWithdrawal();

  console.log("ALLSERVICESSTARTED");
}

/* ================= RUN ================= */

start().catch((error) => {
  console.error(
    "FATALERROR:",
    error
  );

  console.error(error.stack);

  process.exit(1);
});

/* ================= EXPORTS ================= */

export {
  checkContractBalance,
  vault,
  wallet,
  provider,
  CONTRACT_ADDRESS,
  USDC,
  TOKEN_MAP
};
