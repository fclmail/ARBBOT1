// arbjs.js  
// Drop-in arbitrage runner with continuous scanning and safety improvements

import { ethers } from "ethers";

// ----------------------------  
// CONFIGURATION  
// ----------------------------  

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;

if (!PRIVATE_KEY || !RPC_URL) {
  throw new Error("Missing PRIVATE_KEY or RPC_URL environment variable");
}

const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

const ROUTERS = [
  "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff", // QuickSwap
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", // SushiSwap
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607", // ApeSwap
];

const TOKENS = [
  "0xd6df932a45c0f255f85145f286ea0b292b21c90b", // AAVE
  "0x172370d5cd63279efa6d502dab29171933a610af", // CRV
  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", // LINK
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
];

const MIN_PROFIT_USDC = 10 * 1e6; // 10 USDC minimum

const CYCLE_INTERVAL_MS = process.env.CYCLE_INTERVAL_MS
  ? parseInt(process.env.CYCLE_INTERVAL_MS)
  : 60_000;

// Vault ABI
const VAULT_ABI = [
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",
  "function approveRouter(address router,address token) external",
  "function balanceOf(address) view returns(uint256)"
];

// ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

// ----------------------------  
// SETUP PROVIDER & WALLET  
// ----------------------------  

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ----------------------------  
// STATE & HELPERS  
// ----------------------------  

let arbInProgress = false;
const approvalCache = new Map();

// Approve a router for a token if not already done
async function approveRouter(router, token) {
  const key = `${router}_${token}`;
  if (approvalCache.get(key)) return;

  const erc20 = new ethers.Contract(token, ERC20_ABI, wallet);
  const allowance = await erc20.allowance(wallet.address, router);
  if (allowance === 0n) {
    console.log(`Approving router ${router} for token ${token}`);
    const tx = await erc20.approve(router, ethers.MaxUint256);
    await tx.wait();
    console.log(`✅ Approved router ${router} for token ${token}`);
  }
  approvalCache.set(key, true);
}

// Dummy profit estimator (replace with real price fetch & calculation)
async function estimateProfitableOpportunity(token, buyRouter, sellRouter) {
  // TODO: fetch prices from buyRouter and sellRouter
  // return expected USDC profit in smallest units (6 decimals)
  return 15n * 1_000_000n; // example: 15 USDC profit
}

// Execute arbitrage on-chain
async function executeArb(token, buyRouter, sellRouter, expectedProfit) {
  console.log(
    `🚀 Executing arbitrage ${token} | ${buyRouter} -> ${sellRouter} | expected profit: ${Number(expectedProfit) / 1e6} USDC`
  );

  const usdcBalance = await vault.balanceOf(wallet.address);
  const amountInUSDC = usdcBalance >= expectedProfit ? expectedProfit : usdcBalance;

  if (amountInUSDC === 0n) {
    console.log("⚠️ Vault has zero USDC; skipping arbitrage.");
    return;
  }

  const deadline = Math.floor(Date.now() / 1000) + 60; // 1 min expiry

  try {
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountInUSDC,
      0, // minTokenOut (off-chain calculation recommended)
      0, // minUSDCOut (off-chain calculation recommended)
      deadline
    );
    const receipt = await tx.wait();
    console.log(`✅ Arbitrage executed in tx: ${receipt.transactionHash}`);
  } catch (err) {
    console.error("⚠️ Arbitrage failed:", err?.reason || err?.message || err);
  }
}

// ----------------------------  
// MAIN CYCLE  
// ----------------------------  

async function runCycle() {
  if (arbInProgress) {
    console.log("⚠️ Arb in progress; skipping this cycle.");
    return;
  }
  arbInProgress = true;

  const cycleStart = Date.now();
  console.log(`🔄 Starting scan cycle at ${new Date(cycleStart).toISOString()}`);

  try {
    for (const token of TOKENS) {
      for (const buyRouter of ROUTERS) {
        for (const sellRouter of ROUTERS) {
          if (buyRouter === sellRouter) continue;

          const expectedProfit = await estimateProfitableOpportunity(token, buyRouter, sellRouter);
          console.log(
            `${token} | ${buyRouter} -> ${sellRouter} | estimated profit: ${Number(expectedProfit) / 1e6} USDC`
          );

          if (BigInt(expectedProfit) >= BigInt(MIN_PROFIT_USDC)) {
            await approveRouter(buyRouter, token);
            await approveRouter(sellRouter, token);
            await executeArb(token, buyRouter, sellRouter, expectedProfit);
          }
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error in cycle:", err?.reason || err?.message || err);
  } finally {
    arbInProgress = false;
    console.log(`⏱ Cycle completed in ${Date.now() - cycleStart} ms`);
  }
}

// ----------------------------  
// CONTINUOUS SCAN LOOP  
// ----------------------------  

async function mainLoop() {
  while (true) {
    await runCycle();
    await new Promise((r) => setTimeout(r, CYCLE_INTERVAL_MS));
  }
}

mainLoop().catch((err) => console.error("Fatal error in main loop:", err));
