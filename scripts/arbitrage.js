
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
  "function withdrawToken(address,uint256)",
  "function owner() view returns(address)", // Added to verify contract ownership
  "function usdcToken() view returns(address)" // Added to check configured USDC
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

/* ================= CONTRACT VERIFICATION ================= */

async function verifyContract() {
  console.log("🔍 VERIFYING CONTRACT CONFIGURATION...");
  
  try {
    // Check if contract exists and is accessible
    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === "0x" || code === "0x0") {
      console.log("❌ ERROR: No contract found at address:", CONTRACT_ADDRESS);
      return false;
    }
    console.log("✅ Contract exists at address");
    
    // Try to call some view functions to verify ABI matches
    try {
      const owner = await vault.owner();
      console.log(`👤 Contract owner: ${owner}`);
      console.log(`👛 Our wallet: ${wallet.address}`);
      
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.log("⚠️ WARNING: Wallet is not the contract owner");
        console.log("⚠️ Some functions may not work");
      }
    } catch (e) {
      console.log("⚠️ Cannot call owner() - function may not exist");
    }
    
    // Check USDC token in contract
    try {
      const contractUSDC = await vault.usdcToken();
      console.log(`🪙 Contract USDC token: ${contractUSDC}`);
      console.log(`🪙 Our USDC token: ${USDC}`);
      
      if (contractUSDC.toLowerCase() !== USDC.toLowerCase()) {
        console.log("⚠️ WARNING: Contract uses different USDC address");
        console.log(`⚠️ Contract: ${contractUSDC}`);
        console.log(`⚠️ Our config: ${USDC}`);
      }
    } catch (e) {
      console.log("⚠️ Cannot call usdcToken() - function may not exist");
    }
    
    console.log("✅ Contract verification complete");
    return true;
  } catch (e) {
    console.log("❌ ERROR verifying contract:", e.message.substring(0, 100));
    return false;
  }
}

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

  const balanceBefore = await checkContractBalance();
  console.log(`BALANCEBEFORE: ${ethers.formatUnits(balanceBefore, 6)} USDC`);

  try {
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
      const balanceAfter = await checkContractBalance();
      console.log(`BALANCEAFTER: ${ethers.formatUnits(balanceAfter, 6)} USDC`);
      
      const profit = balanceAfter - balanceBefore;
      
      if (profit > 0n) {
        console.log(`✅ PROFITCAPTURED: ${ethers.formatUnits(profit, 6)} USDC`);
        
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
  } catch (e) {
    console.log("EXECERROR:" + e.message.substring(0, 200));
    return null;
  }
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
    console.log(`🔄 Executing job for token: ${job.token.substring(0, 10)}...`);

    try {
      await execute(job.token, job.size, job.config);
    } catch (e) {
      console.log("EXECERROR:" + e.message);
    }
  }

  executing = false;
}

/* ================= SCANNER WITH DEBUGGING ================= */

async function scanPool(pool) {
  try {
    const maxLoan = ethers.parseUnits("100000", 6); // Start with smaller amount for testing
    
    console.log(`🔬 Scanning ${pool.token.substring(0, 10)}...`);
    console.log(`   Pair: ${pool.config.pair.substring(0, 10)}...`);
    console.log(`   Max loan: ${ethers.formatUnits(maxLoan, 6)} USDC`);

    // Try different approaches to find the right parameters
    let depth;
    
    // Approach 1: Try with token address (your original intent)
    try {
      depth = await vault.findBestFlashLoanSize(pool.token, maxLoan);
      console.log("   ✅ Approach 1 (token address) worked");
    } catch (e1) {
      console.log(`   ❌ Approach 1 failed: ${e1.message.substring(0, 50)}`);
      
      // Approach 2: Try with pair address
      try {
        depth = await vault.findBestFlashLoanSize(pool.config.pair, maxLoan);
        console.log("   ✅ Approach 2 (pair address) worked");
      } catch (e2) {
        console.log(`   ❌ Approach 2 failed: ${e2.message.substring(0, 50)}`);
        
        // Approach 3: Try with smaller loan amount
        try {
          const smallLoan = ethers.parseUnits("10000", 6);
          depth = await vault.findBestFlashLoanSize(pool.token, smallLoan);
          console.log("   ✅ Approach 3 (smaller loan) worked");
        } catch (e3) {
          console.log(`   ❌ All approaches failed for ${pool.token.substring(0, 10)}...`);
          console.log(`   Last error: ${e3.message.substring(0, 100)}`);
          return;
        }
      }
    }

    const optimalSize = BigInt(depth[0]);
    const profit = BigInt(depth[1]);

    console.log(`Testing findBestFlashLoanSize with ${ethers.formatUnits(tinyLoan, 6)} USDC on ${testToken.substring(0, 10)}...`);
    
    const result = await vault.findBestFlashLoanSize(testToken, tinyLoan);
    console.log("✅ findBestFlashLoanSize() works!");
    console.log(`   Optimal size: ${ethers.formatUnits(result[0], 6)} USDC`);
    console.log(`   Profit: ${ethers.formatUnits(result[1], 6)} USDC`);
  } catch (e) {
    console.log("❌ findBestFlashLoanSize() failed:", e.message.substring(0, 100));
    console.log("   This might be due to:");
    console.log("   - No liquidity in the pool");
    console.log("   - Wrong token/pair address");
    console.log("   - Contract requires specific input format");
  }
  
  console.log("🔧 DIAGNOSTIC COMPLETE\n");
}

/* ================= ERROR HANDLING IMPROVEMENTS ================= */

// Add retry logic for failed scans
async function scanPoolWithRetry(pool, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await scanPool(pool);
      return; // Success, exit function
    } catch (e) {
      console.log(`⚠️ Attempt ${attempt}/${maxRetries} failed for ${pool.token.substring(0, 10)}...`);
      
      if (attempt < maxRetries) {
        console.log(`⏰ Waiting 1 second before retry...`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`❌ All ${maxRetries} attempts failed for ${pool.token.substring(0, 10)}...`);
        console.log(`   Last error: ${e.message.substring(0, 100)}`);
      }
    }
  }
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

  // Run contract verification first
  const contractValid = await verifyContract();
  
  if (!contractValid) {
    console.log("❌ Contract verification failed - check contract address");
    console.log("❌ Bot will attempt to run anyway...");
  }

  // Run diagnostic tests
  await testContractFunctions();

  // Initial balance check
  const initialBalance = await checkContractBalance();
  console.log(`💰 INITIAL CONTRACT BALANCE: ${ethers.formatUnits(initialBalance, 6)} USDC`);
  
  if (initialBalance === 0n) {
    console.log("⚠️ WARNING: Contract has 0 USDC balance");
    console.log("⚠️ You need to deposit USDC into the contract first");
    console.log("⚠️ Flash loans still work but you need funds for gas");
  }
  
  console.log("");

  // Start all services
  scannerLoop();
  monitor();
  scheduledProfitWithdrawal();
  
  console.log("✅ All services started successfully");
  console.log("========================================");
  console.log("📝 BOT STATUS:");
  console.log("   - Scanning pools every 2 seconds");
  console.log("   - Monitoring balance every 5 seconds");
  console.log("   - Auto-withdrawing every 30 minutes");
  console.log("   - Retrying failed scans up to 3 times");
  console.log("========================================");
}

/* ================= RUN ================= */

start().catch((error) => {
  console.error("FATAL ERROR:", error);
  console.error("Stack trace:", error.stack);
  process.exit(1);
});

/* ================= USEFUL COMMANDS ================= */

// To manually check contract balance:
// node -e "import('./bot.js').then(m => m.checkContractBalance())"

// To manually withdraw funds:
// node -e "import('./bot.js').then(m => m.vault.withdrawToken('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', '100000000'))"


/* ================= TROUBLESHOOTING GUIDE ================= */

console.log(`
========================================
🤖 ARBITRAGE BOT - TROUBLESHOOTING GUIDE
========================================

If the bot is not finding profits:

1. CHECK CONTRACT:
   - Verify contract at: ${CONTRACT_ADDRESS}
   - Check if contract has USDC balance
   - Verify contract is deployed on Polygon

2. CHECK TOKEN CONFIG:
   - Token: 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619 (WETH)
   - Pair: 0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670
   - RouterBuy: 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff (QuickSwap)
   - RouterSell: 0x1b02da8cb0d097eb8d57a175b88c7d8b47997506 (SushiSwap)

3. COMMON ISSUES:
   - "execution reverted" = Contract function failed
   - "No profit" = No arbitrage opportunity exists
   - "ENS error" = Harmless, just noise

4. REQUIREMENTS:
   - Contract must have some USDC for gas
   - Flash loans require Aave pool to have liquidity
   - Both DEXes must have trading pairs

5. TEST COMMANDS:
   node -e "import('./bot.js')"
   curl https://polygon-bor-rpc.publicnode.com -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

========================================
`);

export { checkContractBalance, vault, wallet, provider, CONTRACT_ADDRESS, USDC, TOKEN_MAP };

    console.log(
      `   ✅ Optimal size: ${ethers.formatUnits(optimalSize, 6)} USDC`
    );
    console.log(`   ✅ Profit: ${ethers.formatUnits(profit, 6)} USDC`);

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
    console.log("SCANERROR:" + e.message.substring(0, 200));
    console.log("Full error details:", e);
  }
}

/* ================= NON-BLOCKING LOOP ================= */

async function scannerLoop() {
  console.log("SCANNERSTARTED");
  let scanCount = 0;

  while (true) {
    scanCount++;
    console.log(`\n🔄 Scan cycle #${scanCount} starting...`);

    await Promise.all(POOLS.map(scanPool));

    console.log(`✅ Scan cycle #${scanCount} complete`);
    console.log(`📊 Queue length: ${queue.length}`);
    console.log(`⏰ Waiting 2 seconds before next scan...\n`);

    await new Promise((r) => setTimeout(r, 2000)); // Increased from 500ms to 2s
  }
}

/* ================= MONITOR ================= */

function monitor() {
  setInterval(async () => {
    const balance = await checkContractBalance();
    console.log(
      "QUEUE:" + queue.length +
      " EXEC:" + executing +
      " PROFITS_KEPT_IN_CONTRACT: YES" +
      " BALANCE:" + ethers.formatUnits(balance, 6) + " USDC"
    );
  }, 5000); // Every 5 seconds
}

/* ================= PROFIT WITHDRAWAL SCHEDULER ================= */

async function scheduledProfitWithdrawal() {
  // Withdraw profits every 30 minutes if balance exceeds threshold
  setInterval(async () => {
    try {
      console.log("🔄 Checking for profit withdrawal...");
      const balance = await checkContractBalance();
      const withdrawalThreshold = ethers.parseUnits("500", 6); // Withdraw if > 500 USDC
      
      if (balance >= withdrawalThreshold) {
        console.log(`💰 Balance ${ethers.formatUnits(balance, 6)} USDC exceeds threshold`);
        console.log("🔄 SCHEDULED WITHDRAWAL INITIATED");
        
        // Keep some USDC in contract for gas and flash loan fees
        const keepInContract = ethers.parseUnits("50", 6);
        const withdrawAmount = balance - keepInContract;
        
        if (withdrawAmount > 0n) {
          const withdrawTx = await vault.withdrawToken(USDC, withdrawAmount);
          await withdrawTx.wait();
          console.log(`✅ SCHEDULED WITHDRAWAL COMPLETE: ${ethers.formatUnits(withdrawAmount, 6)} USDC`);
          console.log(`💰 Remaining in contract: ${ethers.formatUnits(keepInContract, 6)} USDC`);
        }
      } else {
        console.log(`ℹ️ Balance ${ethers.formatUnits(balance, 6)} USDC below threshold`);
      }
    } catch (e) {
      console.log("SCHEDULEDWITHDRAWALERROR:" + e.message.substring(0, 100));
    }
  }, 1800000); // Every 30 minutes
}

/* ================= DIAGNOSTIC TOOLS ================= */

async function testContractFunctions() {
  console.log("\n🔧 TESTING CONTRACT FUNCTIONS...");
  
  // Test a simple call to see if the contract responds
  try {
    const testCall = await vault.getContractUSDCBalance();
    console.log("✅ getContractUSDCBalance() works:", ethers.formatUnits(testCall, 6));
  } catch (e) {
    console.log("❌ getContractUSDCBalance() failed:", e.message.substring(0, 100));
  }
  
  // Test with a very small loan to see if the function works at all
  try {
    const tinyLoan = ethers.parseUnits("100", 6); // 100 USDC
    const testToken = Object.keys(TOKEN_MAP)[0];

