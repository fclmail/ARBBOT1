// arbjs.js
import { ethers } from "ethers";

// ----------------------------
// CONFIGURATION
// ----------------------------
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;

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

const MIN_PROFIT_USDC = 10 * 1e6; // 10 USDC
const CYCLE_INTERVAL_MS = process.env.CYCLE_INTERVAL_MS
  ? parseInt(process.env.CYCLE_INTERVAL_MS)
  : 60_000;

// Vault and ERC20 ABIs
const VAULT_ABI = [
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",
  "function approveRouter(address router,address token) external",
  "function balanceOf(address) view returns(uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns(uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transferFrom(address from,address to,uint256 amount) external returns (bool)",
];

// ----------------------------
// PROVIDER & WALLET
// ----------------------------
if (!PRIVATE_KEY || !RPC_URL) throw new Error("Missing PRIVATE_KEY or RPC_URL");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ----------------------------
// STATE
// ----------------------------
const approvalCache = new Map();
let arbInProgress = false;

// ----------------------------
// HELPERS
// ----------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, maxRetries = 3, delayMs = 2000) {
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

async function buildTxOptions() {
  let gasPrice;
  try {
    gasPrice = await provider.getGasPrice();
    const min = ethers.utils.parseUnits("20", "gwei");
    if (gasPrice.lt(min)) gasPrice = min;
    gasPrice = gasPrice.mul(13).div(10); // ~1.3x
  } catch {
    gasPrice = ethers.utils.parseUnits("60", "gwei");
  }
  return { gasPrice, gasLimit: 300000 };
}

// ----------------------------
// APPROVAL
// ----------------------------
async function approveRouter(router, token) {
  const key = `${router}_${token}`;
  if (approvalCache.get(key)) return;

  if (!router || !token) {
    console.warn("⚠️ Invalid router or token address, skipping approval");
    return;
  }

  await withRetry(async () => {
    const txOptions = await buildTxOptions();
    const estimatedGas = await vault.estimateGas
      .approveRouter(router, token)
      .catch(() => ethers.BigNumber.from(txOptions.gasLimit));
    const tx = await vault.approveRouter(router, token, {
      gasPrice: txOptions.gasPrice,
      gasLimit: estimatedGas.toNumber(),
    });
    console.log(`🔑 Approval tx hash: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ Router ${router} approved for token ${token}`);
    approvalCache.set(key, true);
  });
}

// ----------------------------
// PROFIT ESTIMATION (placeholder)
// ----------------------------
async function estimateProfitableOpportunity(token, buyRouter, sellRouter) {
  // Replace with real on-chain pricing logic
  const simulated = Math.floor(Math.random() * 50) + 5;
  return BigInt(simulated * 1e6);
}

// ----------------------------
// ARBITRAGE EXECUTION
// ----------------------------
async function executeArb(token, buyRouter, sellRouter, expectedProfit) {
  const usdcBalance = await vault.balanceOf(wallet.address);
  if (usdcBalance < expectedProfit) {
    console.log(
      `⚠️ Skipping: Vault balance ${Number(usdcBalance) / 1e6} < expected profit ${Number(
        expectedProfit
      ) / 1e6} USDC`
    );
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  await withRetry(async () => {
    const txOptions = await buildTxOptions();
    const estimatedGas = await vault.estimateGas
      .executeArbitrage(buyRouter, sellRouter, token, expectedProfit, 0, 0, now + 60)
      .catch(() => ethers.BigNumber.from(txOptions.gasLimit));
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      expectedProfit,
      0,
      0,
      now + 60,
      { gasPrice: txOptions.gasPrice, gasLimit: estimatedGas.toNumber() }
    );
    console.log(`🚀 Arbitrage tx hash: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ Arbitrage executed successfully`);
  });
}

// ----------------------------
// MAIN CYCLE
// ----------------------------
async function runCycle() {
  if (arbInProgress) return console.log("⚠️ Arb in progress; skipping cycle.");
  arbInProgress = true;
  const cycleStart = Date.now();
  console.log(`🔄 Starting scan cycle at ${new Date(cycleStart).toISOString()}`);

  try {
    for (const token of TOKENS) {
      for (const buyRouter of ROUTERS) {
        for (const sellRouter of ROUTERS) {
          if (buyRouter === sellRouter) continue;
          const profit = await estimateProfitableOpportunity(token, buyRouter, sellRouter);
          console.log(`${token} | ${buyRouter} -> ${sellRouter} | estimated profit: ${Number(profit)/1e6} USDC`);
          if (profit >= BigInt(MIN_PROFIT_USDC)) {
            await approveRouter(buyRouter, token);
            await approveRouter(sellRouter, token);
            await executeArb(token, buyRouter, sellRouter, profit);
          }
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error during cycle:", err?.reason || err?.message || err);
  } finally {
    arbInProgress = false;
    console.log(`⏱ Cycle completed in ${Date.now() - cycleStart} ms`);
  }
}

// ----------------------------
// CONTINUOUS LOOP
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
(async () => {
  console.log("🟢 arbjs starting...");
  await mainLoop();
})();
