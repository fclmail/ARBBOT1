import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= CONFIG ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PK");

const RPC = "https://polygon-bor-rpc.publicnode.com";

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC, {
  name: "polygon",
  chainId: 137,
  ensAddress: null
});

provider.ens = null;

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
  "function withdrawToken(address,uint256)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/* ================= TOKEN CONFIG ================= */

const TOKEN_MAP = {
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {
    pair: "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670",
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
  }
};

/* ================= CONVERT TO POOLS (MULTI-SCAN) ================= */

const POOLS = Object.entries(TOKEN_MAP).map(([token, cfg]) => ({
  token,
  config: cfg
}));

/* ================= QUEUE SYSTEM ================= */

const queue = [];
let executing = false;

/* ================= BALANCE CHECK ================= */

async function checkContractBalance() {
  try {
    const usdcContract = new ethers.Contract(
      USDC,
      ["function balanceOf(address) view returns(uint256)"],
      provider
    );

    const balance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    console.log("CONTRACTUSDCBALANCE:" + ethers.formatUnits(balance, 6));
    return balance;
  } catch (e) {
    console.log("BALANCECHECKERROR:" + e.message.substring(0, 100));
    return 0n;
  }
}

/* ================= EXECUTION ================= */

async function execute(token, size, config) {
  const route = {
    routerBuy: config.routerBuy,
    routerSell: config.routerSell,
    token
  };

  console.log("EXECMODE:FLASH");
  console.log("AAVECALLBACKSTART");

  const tx = await vault.startAaveFlashArbitrage(
    USDC,
    size,
    route,
    ethers.parseUnits("0.000001", 6)
  );

  console.log("TXHASH:" + tx.hash);

  const receipt = await tx.wait();
  console.log("TXSTATUS:" + receipt.status);

  return receipt.blockNumber;
}

/* ================= QUEUE EXECUTOR ================= */

function enqueue(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (executing) return;
  executing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      await execute(job.token, job.size, job.config);
    } catch (e) {
      console.log("EXECERROR:" + e.message);
    }
  }

  executing = false;
}

/* ================= SCANNER ================= */

async function scanPool(pool) {
  try {
    const maxLoan = ethers.parseUnits("100000", 6);

    const depth = await vault.findBestFlashLoanSize(
      pool.config.pair,
      maxLoan
    );

    const optimalSize = BigInt(depth[0]);
    const profit = BigInt(depth[1]);

    console.log(
      "SCAN:" +
        pool.token +
        " SIZE:" +
        optimalSize +
        " PROFIT:" +
        profit
    );

    if (profit > 0n) {
      enqueue({
        token: pool.token,
        size: optimalSize,
        config: pool.config
      });
    }
  } catch (e) {
    console.log("SCANERROR:" + e.message.substring(0, 100));
  }
}

/* ================= NON-BLOCKING LOOP ================= */

async function scannerLoop() {
  console.log("SCANNERSTARTED");

  while (true) {
    await Promise.all(POOLS.map(scanPool));

    await new Promise((r) => setTimeout(r, 500));
  }
}

/* ================= MONITOR ================= */

function monitor() {
  setInterval(() => {
    console.log(
      "QUEUE:" +
        queue.length +
        " EXEC:" +
        executing
    );
  }, 2000);
}

/* ================= START ================= */

async function start() {
  console.log("ARBITRAGEBOTSTARTED");
  console.log("WALLET:" + wallet.address);
  console.log("CONTRACT:" + CONTRACT_ADDRESS);

  checkContractBalance();

  scannerLoop();
  monitor();
}

start();
