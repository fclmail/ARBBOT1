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
  // Add more tokens here with their pair addresses and routers
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

  // Check balance before execution
  const balanceBefore = await checkContractBalance();
  console.log(`BALANCEBEFORE: ${ethers.formatUnits(balanceBefore, 6)} USDC`);

  const tx = await vault.startAaveFlashArbitrage(
    USDC,
    size,
    route,
    ethers.parseUnits("0.000001", 6)
  );

  console.log("TXHASH:" + tx.hash);

  const receipt = await tx.wait();
  console.log("TXSTATUS:" + receipt.status);

  if (receipt.status === 1) {
    // Check balance after execution
    const balanceAfter = await checkContractBalance();
    console.log(`BALANCEAFTER: ${ethers.formatUnits(balanceAfter, 6)} USDC`);
    
    // Calculate profit
    const profit = balanceAfter - balanceBefore;
    
    if (profit > 0n) {
      console.log(`✅ PROFITCAPTURED: ${ethers.formatUnits(profit, 6)} USDC`);
      
      // Optional: Auto-withdraw if profit exceeds threshold (100 USDC)
      const withdrawalThreshold = ethers.parseUnits("100", 6);
      if (profit >= withdrawalThreshold) {
        try {
          const withdrawTx = await vault.withdrawToken(USDC, profit);
          await withdrawTx.wait();
          console.log(`✅ PROFITWITHDRAWN: ${ethers.formatUnits(profit, 6)} USDC to wallet`);
        } catch (withdrawError) {
          console.log("WITHDRAWERROR:" + withdrawError.message.substring(0, 100));
        }
      }
    } else {
      console.log("⚠️ No profit captured in this execution");
    }
  }

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

    // FIX: Use token address, not pair address
    const depth = await vault.findBestFlashLoanSize(
      pool.token,  // ✅ Changed from pool.config.pair
      maxLoan
    );

    const optimalSize = BigInt(depth[0]);
    const profit = BigInt(depth[1]);

    console.log(
      `SCAN: ${pool.token.substring(0, 10)}... ` +
      `SIZE: ${ethers.formatUnits(optimalSize, 6)} USDC ` +
      `PROFIT: ${ethers.formatUnits(profit, 6)} USDC`
    );

    if (profit > 0n) {
      console.log("✅ PROFITABLE OPPORTUNITY FOUND - QUEUED");
      enqueue({
        token: pool.token,
        size: optimalSize,
        config: pool.config
      });
    } else {
      console.log(`❌ No profit for ${pool.token.substring(0, 10)}...`);
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
  setInterval(async () => {
    console.log(
      "QUEUE:" + queue.length +
      " EXEC:" + executing +
      " PROFITS_KEPT_IN_CONTRACT: YES"
    );
    
    // Periodically check and display contract balance
    const balance = await checkContractBalance();
    console.log(`💰 CONTRACT USDC BALANCE: ${ethers.formatUnits(balance, 6)}`);
  }, 2000);
}

/* ================= PROFIT WITHDRAWAL SCHEDULER ================= */

async function scheduledProfitWithdrawal() {
  // Withdraw profits every 10 minutes if balance exceeds threshold
  setInterval(async () => {
    try {
      const balance = await checkContractBalance();
      const withdrawalThreshold = ethers.parseUnits("1000", 6); // Withdraw if > 1000 USDC
      
      if (balance >= withdrawalThreshold) {
        console.log("🔄 SCHEDULED WITHDRAWAL INITIATED");
        const withdrawTx = await vault.withdrawToken(USDC, balance);
        await withdrawTx.wait();
        console.log(`✅ SCHEDULED WITHDRAWAL COMPLETE: ${ethers.formatUnits(balance, 6)} USDC`);
      }
    } catch (e) {
      console.log("SCHEDULEDWITHDRAWALERROR:" + e.message.substring(0, 100));
    }
  }, 600000); // Every 10 minutes
}

/* ================= START ================= */

async function start() {
  console.log("========================================");
  console.log("🤖 ARBITRAGE BOT STARTED");
  console.log("========================================");
  console.log(`👛 WALLET: ${wallet.address}`);
  console.log(`📄 CONTRACT: ${CONTRACT_ADDRESS}`);
  console.log(`🪙 USDC TOKEN: ${USDC}`);
  console.log(`📊 SCANNING ${POOLS.length} POOL(S)`);
  console.log("========================================");

  // Initial balance check
  const initialBalance = await checkContractBalance();
  console.log(`💰 INITIAL CONTRACT BALANCE: ${ethers.formatUnits(initialBalance, 6)} USDC`);
  console.log("");

  // Start all services
  scannerLoop();
  monitor();
  scheduledProfitWithdrawal();
  
  console.log("✅ All services started successfully");
  console.log("========================================");
}

/* ================= RUN ================= */

start().catch((error) => {
  console.error("FATAL ERROR:", error);
  process.exit(1);
});
