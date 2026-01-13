// arbjs.js  
// Single-file arbjs with robust guards, granular logging, and retryable network calls  

import { ethers } from "ethers";  

// ----------------------------  
// CONFIGURATION  
// ----------------------------  

// Load from environment variables  
const PRIVATE_KEY = process.env.PRIVATE_KEY;  
const RPC_URL = process.env.RPC_URL;  

// Vault contract address and USDC token (must match your deployed contract)  
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";  

// Routers to scan  
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
const MIN_PROFIT_USDC = 10 * 1e6; // 10 USDC (assuming 6 decimals)  
const CYCLE_INTERVAL_MS = process.env.CYCLE_INTERVAL_MS  
  ? parseInt(process.env.CYCLE_INTERVAL_MS)  
  : 60_000; // default 60s  

// Gas strategy  
const DEFAULT_GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI  
  ? parseInt(process.env.GAS_PRICE_GWEI)  
  : 60; // 60 gwei default  
const GAS_PRICE_MIN_GWEI = 20; // floor  
const DEFAULT_GAS_LIMIT = process.env.GAS_LIMIT  
  ? parseInt(process.env.GAS_LIMIT)  
  : 300000;  

// Retry configuration  
const MAX_RETRIES = process.env.MAX_RETRIES  
  ? parseInt(process.env.MAX_RETRIES)  
  : 3;  
const RETRY_DELAY_MS = process.env.RETRY_DELAY_MS  
  ? parseInt(process.env.RETRY_DELAY_MS)  
  : 2000;  

// Vault ABI (simplified)  
const VAULT_ABI = [  
  "function USDC() view returns (address)",  
  "function owner() view returns (address)",  
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",  
  "function approveRouter(address router,address token) external",  
  "function balanceOf(address) view returns(uint256)",  
];  

// ERC20 ABI (simplified)  
const ERC20_ABI = [  
  "function balanceOf(address) view returns (uint256)",  
  "function allowance(address owner,address spender) view returns (uint256)",  
  "function approve(address spender,uint256 amount) returns (bool)",  
  "function transferFrom(address from,address to,uint256 amount) external returns (bool)",  
];  

// ----------------------------  
// SETUP PROVIDER & WALLET  
// ----------------------------  
if (!PRIVATE_KEY || !RPC_URL) {  
  throw new Error("Missing PRIVATE_KEY or RPC_URL environment variables");  
}  

const provider = new ethers.JsonRpcProvider(RPC_URL);  
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);  
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);  

// Cache approvals to prevent duplicate txs  
const approvalCache = new Map();  
let arbInProgress = false;  

// ----------------------------  
// HELPERS  
// ----------------------------  
function sleep(ms) {  
  return new Promise((resolve) => setTimeout(resolve, ms));  
}  

// Basic retry wrapper for critical calls  
async function withRetry(fn, maxRetries = MAX_RETRIES, delayMs = RETRY_DELAY_MS) {  
  let attempt = 0;  
  while (true) {  
    try {  
      return await fn();  
    } catch (e) {  
      attempt++;  
      if (attempt >= maxRetries) throw e;  
      console.warn(`Retry ${attempt}/${maxRetries} after error:`, (e && e.message) || e);  
      await sleep(delayMs * attempt);  
    }  
  }  
}  

// Simple gas estimation helper (optional)  
async function estimateGasOrDefault(callable, fallbackGas) {  
  try {  
    const est = await callable.estimateGas();  
    // add a 20% safety margin  
    return est.mul(120).div(100).toNumber();  
  } catch {  
    return fallbackGas;  
  }  
}  

// ----------------------------  
// GAS CONFIGURATIONS  
// ----------------------------  
function gasPriceFromNetwork() {  
  // Get current gas price and apply a multiplier  
  // If provider.getGasPrice fails, fall back to default  
  return withRetry(async () => {  
    const current = await provider.getGasPrice(); // BigNumber  
    // Convert to gwei for readability (not required)  
    const multiplier = 1.3;  
    return current.mul(Math.floor(multiplier * 1e6)).div(1e6); // keep as BigNumber  
  }).catch(() => ethers.utils.parseUnits(String(DEFAULT_GAS_PRICE_GWEI), "gwei"));  
}  

// Build a standard options object  
async function buildTxOptions(extra = {}) {  
  // Ensure gasPrice is reasonable  
  let gasPrice;  
  try {  
    gasPrice = await provider.getGasPrice();  
    // Apply floor  
    const floor = ethers.utils.parseUnits(String(GAS_PRICE_MIN_GWEI), "gwei");  
    if (gasPrice.lt(floor)) gasPrice = floor;  
    // Optional: add a small multiplier to speed up  
    gasPrice = gasPrice.mul(13).div(10); // ~1.3x  
  } catch {  
    gasPrice = ethers.utils.parseUnits(String(DEFAULT_GAS_PRICE_GWEI), "gwei");  
  }  

  const gasLimit = extra.gasLimit || DEFAULT_GAS_LIMIT;  

  return {  
    gasPrice,  
    gasLimit,  
  };  
}  

// ----------------------------  
// APPROVAL LOGIC (IDEMPOTENT)  
// ----------------------------  
async function approveRouter(router, token) {  
  const key = `${router}_${token}`;  
  if (approvalCache.get(key)) return;  

  try {  
    console.log(`🔑 Approving router ${router} for token ${token}...`);  

    const txOptions = await buildTxOptions({});  

    // Optional: estimate gas for the call and add a safety margin  
    let estimatedGas;  
    try {  
      estimatedGas = await vault.estimateGas.approveRouter(router, token);  
      // Add 50% margin  
      estimatedGas = estimatedGas.mul(3).div(2);  
    } catch {  
      // Fall back to default if estimation fails  
      estimatedGas = ethers.BigNumber.from(txOptions.gasLimit);  
    }  

    const tx = await vault.approveRouter(router, token, {  
      gasPrice: txOptions.gasPrice,  
      gasLimit: estimatedGas.toNumber(),  
    });  

    console.log(`Approval tx hash: ${tx.hash}`);  
    const receipt = await tx.wait();  
    console.log(`✅ Approval mined in block ${receipt.blockNumber}`);  
    approvalCache.set(key, true);  
  } catch (err) {  
    console.error(`⚠️ Approval failed for ${router}_${token}:`, err?.reason || err?.message || err);  
  }  
}  

// ----------------------------  
// PROFIT ESTIMATION (PLACEHOLDER)  
// ----------------------------  
async function estimateProfitableOpportunity(token, buyRouter, sellRouter) {  
  // Replace with real price fetch logic  
  // For now, return random simulated profit within a plausible range  
  const fakeUSDC = Math.floor(Math.random() * 50) + 5; // 5-54  
  return BigInt(fakeUSDC * 1e6); // in USDC-wei (6 decimals)  
}  

// ----------------------------  
// ARBITRAGE EXECUTION  
// ----------------------------  
async function executeArb(token, buyRouter, sellRouter, expectedProfit) {  
  const usdcBalance = await vault.balanceOf(wallet.address);  
  if (usdcBalance.lt(expectedProfit)) {  
    console.log(  
      `⚠️ Skipping: Vault USDC balance ${Number(usdcBalance) / 1e6} < expected profit ${Number(  
        expectedProfit  
      ) / 1e6}`  
    );  
    return;  
  }  

  console.log(  
    `🚀 Executing arbitrage ${token} | ${buyRouter} -> ${sellRouter} | expected profit: ${Number(  
      expectedProfit  
    ) / 1e6} USDC`  
  );  

  const now = Math.floor(Date.now() / 1000);  

  // Build transaction options with retryable mechanism  
  async function tryArbTxn(attempt = 1) {  
    try {  
      // Optional: you can estimate gas for the actual arbitrage on-chain call  
      let gasPrice;  
      try {  
        const gp = await provider.getGasPrice();  
        // Add a safety multiplier  
        gasPrice = gp.mul(13).div(10); // ~1.3x  
      } catch {  
        gasPrice = (await buildTxOptions({})).gasPrice;  
      }  

      let gasLimit;  
      try {  
        const est = await vault.estimateGas.executeArbitrage(  
          buyRouter,  
          sellRouter,  
          token,  
          expectedProfit,  
          0,  
          0,  
          now + 60  
        );  
        gasLimit = est.mul(120).div(100).toNumber(); // +20% margin  
      } catch {  
        gasLimit = (await buildTxOptions({})).gasLimit;  
      }  

      const tx = await vault.executeArbitrage(  
        buyRouter,  
        sellRouter,  
        token,  
        expectedProfit, // amountInUSDC  
        0, // minTokenOut  
        0, // minUSDCOut  
        now + 60, // deadline  
        {  
          gasPrice,  
          gasLimit,  
        }  
      );  

      console.log(`Arb tx hash: ${tx.hash}`);  
      const receipt = await tx.wait();  
      console.log(`✅ Arbitrage tx mined in block ${receipt.blockNumber}`);  
      return receipt;  
    } catch (err) {  
      console.error(`⚠️ Arbitrage attempt ${attempt} failed:`, err?.reason || err?.message || err);  
      if (attempt < MAX_RETRIES) {  
        const backoff = RETRY_DELAY_MS * attempt;  
        console.log(`🔄 Retrying arbitrage in ${backoff} ms (attempt ${attempt + 1})...`);  
        await sleep(backoff);  
        return tryArbTxn(attempt + 1);  
      } else {  
        throw err;  
      }  
    }  
  }  

  try {  
    await tryArbTxn(1);  
  } catch (err) {  
    console.error("⚠️ Final arb attempt failed:", err?.reason || err?.message || err);  
  }  
}  

// ----------------------------  
// MAIN CYCLE  
// ----------------------------  
async function runCycle() {  
  if (arbInProgress) {  
    console.log("⚠️ Arb in progress; skipping cycle.");  
    return;  
  }  

  arbInProgress = true;  
  const cycleStart = Date.now();  
  console.log(`🔄 Starting new scan cycle at ${new Date(cycleStart).toISOString()}`);  

  try {  
    for (const token of TOKENS) {  
      for (const buyRouter of ROUTERS) {  
        for (const sellRouter of ROUTERS) {  
          if (buyRouter === sellRouter) continue;  

          const expectedProfit = await estimateProfitableOpportunity(token, buyRouter, sellRouter);  
          console.log(  
            `${token} | ${buyRouter} -> ${sellRouter} | estimated profit: ${Number(expectedProfit) / 1e6} USDC`  
          );  

          if (expectedProfit >= BigInt(MIN_PROFIT_USDC)) {  
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
    arbInProgress = false;  
    console.log(`⏱ Cycle completed in ${Date.now() - cycleStart} ms`);  
  }  
}  

// ----------------------------  
// CONTINUOUS SCAN LOOP  
// ----------------------------  
async function mainLoop() {  
  while (true) {  
    try {
      await runCycle();
    } catch (err) {
      console.error("⚠️ Fatal error in main loop:", err?.reason || err?.message || err);
    }
    await sleep(CYCLE_INTERVAL_MS);
  }
}

// ----------------------------
// STARTUP
// ----------------------------
async function startup() {
  console.log("🟢 arbjs startup: validating configuration");
  // Basic sanity checks
  if (!VAULT_ADDRESS || ROUTERS.length === 0 || TOKENS.length === 0) {
    throw new Error("Invalid configuration: VAULT_ADDRESS, ROUTERS, or TOKENS missing");
  }
  console.log(`🔎 Monitoring ${TOKENS.length} tokens across ${ROUTERS.length} routers`);
  console.log(`💰 Min profit set to ${MIN_PROFIT_USDC} USDC; cycle every ${CYCLE_INTERVAL_MS} ms`);

  // Optional: fund verification
  try {
    const bal = await vault.balanceOf(wallet.address);
    console.log(`🏦 Vault USDC balance for this bot: ${Number(bal) / 1e6} USDC`);
  } catch {
    // Non-fatal; continue
  }

  // Kick off main loop
  console.log("🚀 Starting main loop");
  await mainLoop();
}

// Run startup
startup().catch((err) => {
  console.error("🛑 Startup failed:", err?.reason || err?.message || err);
  process.exit(1);
});

// Helpers for compatibility in environments that expect module.exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    runCycle,
    approveRouter,
    estimateProfitableOpportunity,
    executeArb,
  };
}
