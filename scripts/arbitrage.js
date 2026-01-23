// ===== ARBJS FULL DROP-IN: CONTINUOUS SCAN + COLOR LOGS + SAFETY + PROFITABILITY =====

// -------------------- PREQ --------------------
// - dotenv loaded: require('dotenv').config();
// - ethers installed: npm i ethers
// - Environment variables: SLIPPAGE_TOLERANCE, VAULT_MIN_USDC, NET_PROFIT_MIN_USDC, DRY_RUN, etc.
// - RPC provider, wallet, vault contract, routers, TOKENS, ABIs, etc.
// - Constants: MIN_TRADE_USDC, MIN_EXPECTED_PROFIT, DEADLINE_SECONDS, SCAN_DELAY_MS, SCAN_CONCURRENCY, TX_RETRY_ATTEMPTS

import { ethers } from "ethers";

// -------------------- 1) Color utils & logging --------------------
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

function ts() {
  return new Date().toISOString();
}

function logInfo(msg) {
  console.log(`[${ts()}] ${colors.blue}INFO${colors.reset} ${msg}`);
}
function logWarn(msg) {
  console.log(`[${ts()}] ${colors.yellow}WARN${colors.reset} ${msg}`);
}
function logError(msg) {
  console.log(`[${ts()}] ${colors.red}ERROR${colors.reset} ${msg}`);
}
function logSuccess(msg) {
  console.log(`[${ts()}] ${colors.green}SUCCESS${colors.reset} ${msg}`);
}

// Arb-specific logs
function logArbQueued(arb) {
  console.log(
    `[${ts()}] ${colors.green}QUEUED${colors.reset} | Token ${symbol(arb.tokenAddr)} | ` +
      `${arb.buyPath.map(p => symbol(p)).join("->")} -> ${arb.sellPath.map(p => symbol(p)).join("->")} | ` +
      `NetProfit ${arb.profit.toFixed(6)} USDC`
  );
}
function logArbExecuting(arb) {
  console.log(
    `[${ts()}] ${colors.green}EXECUTING${colors.reset} | Token ${symbol(arb.tokenAddr)} | ` +
      `Buy ${dexSymbol(arb.buyRouter)} → Sell ${dexSymbol(arb.sellRouter)} | Path ${arb.buyPath.map(p => symbol(p)).join("->")} | ` +
      `Profit ${arb.profit.toFixed(6)} USDC`
  );
}
function logArbExecutedOK(arb) {
  console.log(
    `[${ts()}] ${colors.green}TX_OK${colors.reset} | Token ${symbol(arb.tokenAddr)} | ` +
      `${dexSymbol(arb.buyRouter)} → ${dexSymbol(arb.sellRouter)} | NetProfit ${arb.profit.toFixed(6)} USDC`
  );
}
function logArbDryRunInfo(arb) {
  console.log(
    `[${ts()}] ${colors.cyan}DRY_RUN${colors.reset} | Would execute arb: ${arb.buyPath.map(p => symbol(p)).join("->")} -> ` +
      `${arb.sellPath.map(p => symbol(p)).join("->")} | NetProfit ${arb.profit.toFixed(6)} USDC`
  );
}

// -------------------- 2) Config & defaults --------------------
const SLIPPAGE_TOLERANCE = Number(process.env.SLIPPAGE_TOLERANCE || 0.005); // 0.5%
const VAULT_MIN_USDC = Number(process.env.VAULT_MIN_USDC || 5000);
const NET_PROFIT_MIN_USDC = Number(process.env.NET_PROFIT_MIN_USDC || 0.00001);
const GAS_LIMIT_PER_TRADE = Number(process.env.GAS_LIMIT_PER_TRADE || 350000);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 180);
let DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
let SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
let TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 2);

// -------------------- 3) Helpers --------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function symbol(addr) {
  return addr || "UNKNOWN";
}
function dexSymbol(router) {
  return String(router) || "DEX";
}

// -------------------- 4) Vault / provider placeholders --------------------
// Replace these with your real provider/wallet/vault instances
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://localhost:8545");
const vault = {
  usdc: async () => {
    return ethers.BigNumber.from("1000000000"); // 1,000 USDC placeholder (6 decimals)
  },
  executeArbitrage: async (buyRouter, sellRouter, amount, buyPath, sellPath, deadline) => {
    // Mock tx object for DRY_RUN
    return {
      hash: "0xMOCKTXHASH",
      wait: async () => true,
    };
  },
};
const TOKENS = {
  USDC: "0xUSDC",
  DAI: "0xDAI",
  USDT: "0xUSDT",
};
const routers = {
  UNISWAP: "0xUNISWAP",
  SUSHISWAP: "0xSUSHI",
};

// -------------------- 5) Core ARB helpers --------------------
async function vaultUSDCBalance() {
  try {
    return await vault.usdc();
  } catch {
    return ethers.BigNumber.from("1000000000"); // fallback 1,000 USDC
  }
}

async function estimateGasUSDCFee() {
  try {
    const gasPrice = await provider.getGasPrice();
    const feeWei = gasPrice.mul(GAS_LIMIT_PER_TRADE);
    const feeEth = Number(ethers.formatEther(feeWei));
    const approxUSDCPerEth = 1000000; // placeholder
    return feeEth * approxUSDCPerEth;
  } catch {
    return 0;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function isPathViable(routerAddr, path) {
  const illiquidHops = new Set([TOKENS.DAI?.toLowerCase(), TOKENS.USDT?.toLowerCase()]);
  for (const hop of path) {
    if (illiquidHops.has((hop || "").toLowerCase())) return false;
  }
  return true;
}

// -------------------- 6) ARB logic --------------------
async function checkArb(buyRouter, sellRouter, tokenAddr, usdcAddr) {
  const amountInUSDC = ethers.parseUnits("500", 6);
  const buyPaths = [[usdcAddr, tokenAddr]]; // placeholder
  const sellPaths = [[tokenAddr, usdcAddr]]; // placeholder
  const estimatedFeeUSDC = await estimateGasUSDCFee();

  for (const buyPath of buyPaths) {
    for (const sellPath of sellPaths) {
      if (buyRouter === sellRouter) continue;
      const buyOut = amountInUSDC; // placeholder quote
      const sellOut = amountInUSDC; // placeholder quote

      const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));
      const grossProfit = receivedUSDC - (MIN_TRADE_USDC || 0);
      const netProfit = grossProfit - estimatedFeeUSDC;

      if (netProfit >= NET_PROFIT_MIN_USDC) {
        const arb = { buyRouter, sellRouter, tokenAddr, buyPath, sellPath, profit: netProfit };
        logArbQueued(arb);
        return arb;
      }
    }
  }
  return null;
}

// -------------------- 7) Execution --------------------
async function execArbWithRetry(arb) {
  const amountIn = ethers.parseUnits((MIN_TRADE_USDC || 0).toString(), 6);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  let lastError;

  for (let attempt = 0; attempt <= TX_RETRY_ATTEMPTS; attempt++) {
    try {
      const tx = await vault.executeArbitrage(arb.buyRouter, arb.sellRouter, amountIn, arb.buyPath, arb.sellPath, deadline);
      logInfo(`⛓ TX SENT: ${tx.hash} (attempt ${attempt + 1})`);
      await tx.wait();
      logArbExecutedOK(arb);
      return true;
    } catch (e) {
      lastError = e;
      logError(`TX FAILED (attempt ${attempt + 1}): ${e?.message ?? e}`);
      const backoff = Math.min(1000 * Math.pow(2, attempt), 32000);
      await sleep(backoff);
    }
  }

  logError(`All tx attempts failed for ${symbol(arb.tokenAddr)}`);
  throw lastError;
}

// -------------------- 8) Queue processing --------------------
let executionQueue = [];
let executing = false;

async function processQueue() {
  if (executing) return;
  executing = true;

  while (executionQueue.length) {
    const arb = executionQueue.shift();
    logArbExecuting(arb);

    if (!DRY_RUN) {
      const bal = await vaultUSDCBalance();
      if (bal.lt(ethers.parseUnits((VAULT_MIN_USDC || 0).toString(), 6))) {
        logWarn(`Vault USDC too low, skipping`);
        continue;
      }
      await execArbWithRetry(arb);
    } else {
      logArbDryRunInfo(arb);
    }

    await sleep(50);
  }

  executing = false;
}

// -------------------- 9) Scan --------------------
async function scan() {
  const vaultBal = await vaultUSDCBalance();
  logInfo(`Vault USDC balance: ${ethers.formatUnits(vaultBal, 6)}`);
  const usdc = TOKENS.USDC;

  const found = [];
  for (const tokenAddr of Object.values(TOKENS)) {
    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {
        if (buyRouter === sellRouter) continue;

        const isViable = await isPathViable(buyRouter, [usdc, tokenAddr]);
        if (!isViable) continue;

        const arb = await checkArb(buyRouter, sellRouter, tokenAddr, usdc);
        if (arb) found.push(arb);
      }
    }
  }

  found.sort((a, b) => b.profit - a.profit).forEach(arb => executionQueue.push(arb));

  if (executionQueue.length) logSuccess(`Queued ${executionQueue.length} profitable arb(s)`);
  else logInfo("No profitable arbitrage opportunities found");

  processQueue();
}

// -------------------- 10) Main Loop --------------------
async function mainLoop() {
  while (true) {
    try {
      await scan();
      await sleep(Number(process.env.SCAN_DELAY_MS || 2000));
    } catch (e) {
      logError(`Unexpected error: ${e?.message ?? e}`);
      await sleep(2000);
    }
  }
}

// -------------------- 11) Bootstrap --------------------
async function bootstrap() {
  logInfo(`ARBJS drop-in started in ${DRY_RUN ? "DRY_RUN" : "LIVE"} mode`);
  await scan();
  mainLoop().catch(err => logError(`Fatal main loop error: ${err?.message ?? err}`));
}

bootstrap();
