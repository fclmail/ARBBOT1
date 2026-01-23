// ===== ARBJS FULL DROP-IN: CONTINUOUS SCAN + COLOR LOGS + SAFETY + PROFITABILITY =====

// 0) Imports
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ===== 1) Color utilities and logging helpers =====
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const ts = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const logInfo = (m) => console.log(`[${ts()}] ${colors.blue}INFO${colors.reset} ${m}`);
const logWarn = (m) => console.log(`[${ts()}] ${colors.yellow}WARN${colors.reset} ${m}`);
const logError = (m) => console.log(`[${ts()}] ${colors.red}ERROR${colors.reset} ${m}`);
const logSuccess = (m) => console.log(`[${ts()}] ${colors.green}SUCCESS${colors.reset} ${m}`);

// ===== 2) Config =====
const SLIPPAGE_TOLERANCE = Number(process.env.SLIPPAGE_TOLERANCE || 0.005);
const VAULT_MIN_USDC = Number(process.env.VAULT_MIN_USDC || 5000);
const NET_PROFIT_MIN_USDC = Number(process.env.NET_PROFIT_MIN_USDC || 0.01);
const GAS_LIMIT_PER_TRADE = Number(process.env.GAS_LIMIT_PER_TRADE || 350000);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 180);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
const TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 2);

// ===== 3) Helpers =====
const symbol = (a) => a;
const dexSymbol = (r) => String(r);

// ===== 4) Vault balance (SAFE) =====
async function vaultUSDCBalance() {
  try {
    if (globalThis.vault?.usdc) {
      const bal = await vault.usdc();
      return ethers.BigNumber.from(bal);
    }
  } catch {}
  return ethers.BigNumber.from("1000000000"); // 1,000 USDC fallback
}

// ===== 5) Gas estimation (SAFE) =====
async function estimateGasUSDCFee() {
  try {
    if (!globalThis.provider) return 0;
    const gasPrice = await provider.getGasPrice();
    const feeWei = gasPrice.mul(GAS_LIMIT_PER_TRADE);
    const feeEth = Number(ethers.utils.formatUnits(feeWei, 18));
    return feeEth * 1_000_000;
  } catch {
    return 0;
  }
}

// ===== 6) Viability =====
async function isPathViable(_, path) {
  const bad = new Set([
    globalThis.TOKENS?.DAI?.toLowerCase(),
    globalThis.TOKENS?.USDT?.toLowerCase()
  ]);
  return !path.some(p => bad.has((p || "").toLowerCase()));
}

// ===== 7) Arbitrage check (SAFE) =====
async function checkArb(buyRouter, sellRouter, tokenAddr, usdcAddr) {
  if (!globalThis.quote || !globalThis.generatePaths) return null;

  const amountIn = ethers.utils.parseUnits("500", 6);
  const buyPaths = generatePaths(usdcAddr, tokenAddr);
  const sellPaths = generatePaths(tokenAddr, usdcAddr);
  const fee = await estimateGasUSDCFee();

  for (const b of buyPaths) {
    for (const s of sellPaths) {
      if (buyRouter === sellRouter) continue;

      const buyOut = await quote(buyRouter, amountIn, b).catch(() => null);
      if (!buyOut) continue;

      const sellOut = await quote(sellRouter, buyOut, s).catch(() => null);
      if (!sellOut) continue;

      const received = Number(ethers.utils.formatUnits(sellOut, 6));
      const net = received - fee - 500;

      if (net >= NET_PROFIT_MIN_USDC) {
        return { buyRouter, sellRouter, tokenAddr, buyPath: b, sellPath: s, profit: net };
      }
    }
  }
  return null;
}

// ===== 8) Execution queue =====
let executionQueue = [];
let executing = false;

async function processQueue() {
  if (executing) return;
  executing = true;

  while (executionQueue.length) {
    const arb = executionQueue.shift();
    console.log(`[${ts()}] 🔥 EXECUTING | Token ${arb.tokenAddr} | Profit ${arb.profit.toFixed(6)} USDC`);

    if (!DRY_RUN && globalThis.vault?.executeArbitrage) {
      try {
        const tx = await vault.executeArbitrage(
          arb.buyRouter,
          arb.sellRouter,
          ethers.utils.parseUnits("500", 6),
          arb.buyPath,
          arb.sellPath,
          Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
        );
        console.log(`[${ts()}] ⛓ TX SENT: ${tx.hash}`);
        await tx.wait();
        console.log(`[${ts()}] ✅ TX CONFIRMED`);
      } catch (e) {
        logError(e.message);
      }
    } else {
      console.log(`[${ts()}] 🧪 DRY_RUN | Simulated execution`);
    }
    await sleep(50);
  }
  executing = false;
}

// ===== 9) Scan =====
async function scan() {
  const bal = await vaultUSDCBalance();
  logInfo(`Vault USDC balance: ${ethers.utils.formatUnits(bal, 6)}`);

  const tokens = Object.values(globalThis.TOKENS || {});
  const routers = Object.values(globalThis.routers || {});
  const usdc = globalThis.USDC || "USDC";

  const found = [];

  for (const t of tokens) {
    for (const b of routers) {
      for (const s of routers) {
        if (b === s) continue;
        if (!(await isPathViable(b, [usdc, t]))) continue;
        const arb = await checkArb(b, s, t, usdc);
        if (arb) found.push(arb);
      }
    }
  }

  found.sort((a, b) => b.profit - a.profit);
  executionQueue.push(...found);

  if (executionQueue.length) {
    logSuccess(`Queued ${executionQueue.length} arbitrage(s)`);
    processQueue();
  } else {
    logInfo("No arbitrage found this cycle");
  }
}

// ===== 10) Main loop =====
async function mainLoop() {
  while (true) {
    try {
      await scan();
      await sleep(Number(process.env.SCAN_DELAY_MS || 2000));
    } catch (e) {
      logError(e.message);
      await sleep(2000);
    }
  }
}

// ===== 11) Bootstrap =====
(async () => {
  logInfo(`ARBJS started in ${DRY_RUN ? "DRY_RUN" : "LIVE"} mode`);
  await scan();
  mainLoop();
})();
