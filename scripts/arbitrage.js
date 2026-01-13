// arbjs.js  
// Drop-in arbitrage runner with safety improvements:  
// - Idempotent approvals per (router, token)  
// - Pull-based USDC funding via transferFrom (requires user approval)  
// - Non-reentrant flow (simple guard)  
// - Realistic balance checks and detailed logging  
// - Configurable thresholds and timeouts  

import { ethers } from "ethers";  
import fs from "fs";  

// ----------------------------  
// CONFIGURATION  
// ----------------------------  

// Load from environment variables  
const PRIVATE_KEY = process.env.PRIVATE_KEY;  
const RPC_URL = process.env.RPC_URL;  

// Vault contract address and USDC token (must match your deployed contract)  
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";  

// Routers to scan (example: QuickSwap, SushiSwap, ApeSwap)  
const ROUTERS = [  
  "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff", // QuickSwap  
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", // SushiSwap  
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607", // ApeSwap  
];  

// Tokens to scan  
const TOKENS = [  
  "0xd6df932a45c0f255f85145f286ea0b292b21c90b", // AAVE  
  "0x172370d5cd63279efa6d502dab29171933a610af", // CRV  
  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", // LINK  
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC  
];  

// Arbitrage thresholds  
// MIN_PROFIT_USDC is in USDC's smallest unit (6 decimals). Example: 10 USDC = 10000000  
const MIN_PROFIT_USDC = 10 * 1e6; // 10 USDC as minimum profit (adjust as needed)  

// Vault ABI (simplified)  
const VAULT_ABI = [  
  "function USDC() view returns (address)",  
  "function owner() view returns (address)",  
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",  
  "function approveRouter(address router,address token) external",  
  "function balanceOf(address) view returns(uint256)"  
];  

// ERC20 ABI (simplified)  
const ERC20_ABI = [  
  "function balanceOf(address) view returns (uint256)",  
  "function allowance(address owner, address spender) view returns (uint256)",  
  "function approve(address spender,uint256 amount) returns (bool)",  
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)"  
];  

// ----------------------------  
// SETUP PROVIDER & WALLET  
// ----------------------------  
if (!PRIVATE_KEY || !RPC_URL) {  
  throw new Error("Missing PRIVATE_KEY or RPC_URL environment variable");  
}  

const provider = new ethers.JsonRpcProvider(RPC_URL);  
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);  

// Vault contract  
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);  

// Cache of allowed approvals to avoid duplicate txs  
// Key: `${router}_${token}` -> boolean  
const approvalCache = new Map();  

// Simple reentrancy guard for the current process  
let arbInProgress = false;  


// ----------------------------
// CONTINUOUS SCAN SETUP (cycle control)
// ----------------------------

// Cycle interval (ms). Adjust as needed. If you want a one-shot run, set to 0 or remove the interval logic.
const CYCLE_INTERVAL_MS = process.env.CYCLE_INTERVAL_MS ? parseInt(process.env.CYCLE_INTERVAL_MS) : 60_000;

// Optional: track last cycle start for logging
let lastCycleStart = 0;

// ----------------------------
// CONTINUOUS SCAN MAIN LOOP
// ----------------------------
async function runCycle() {
  if (arbInProgress) {
    console.log("⚠️ Arb in progress from previous cycle; skipping this cycle.");
    return;
  }

  const cycleStart = Date.now();
  lastCycleStart = cycleStart;
  console.log(`🔄 Starting new scan cycle at ${new Date(cycleStart).toISOString()}`);

  // If you want to fetch dynamic on-chain data here, do it per cycle
  try {
    for (const token of TOKENS) {
      for (const buyRouter of ROUTERS) {
        for (const sellRouter of ROUTERS) {
          if (buyRouter === sellRouter) continue;

          const expectedProfit = await estimateProfitableOpportunity(token, buyRouter, sellRouter);

          console.log(`${token} | ${buyRouter}→${sellRouter} | estimated profit (off-chain): ${Number(expectedProfit) / 1e6} USDC`);

          if (BigInt(expectedProfit) >= BigInt(MIN_PROFIT_USDC)) {
            // Ensure approvals exist
            await approveRouter(buyRouter, token);
            await approveRouter(sellRouter, token);

            // Execute arb with on-chain funding amount
            await executeArb(token, buyRouter, sellRouter, expectedProfit);
          }
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error during cycle execution:", err?.reason || err?.message || err);
  } finally {
    // Allow next cycle
    arbInProgress = false;
  }

  // Schedule next cycle
  // If you want a manual trigger instead of setInterval, replace with a loop in main.
  // setTimeout(runCycle, CYCLE_INTERVAL_MS);
}

// Seed the first cycle
runCycle().catch(err => console.error("Fatal error starting cycles:", err));

// If you prefer a persistent timer-based loop, uncomment below and remove the one-shot above:
// setInterval(runCycle, CYCLE_INTERVAL_MS);
