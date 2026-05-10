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
};];

