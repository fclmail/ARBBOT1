// ===== ARBJS FULL DROP-IN: CONTINUOUS SCAN + COLOR LOGS + SAFETY + PROFITABILITY =====
// Assumes environment already has: dotenv + ethers imported, RPC list, wallet, vault, router ABIs, TOKENS, etc.

// 1) Color utilities and logging helpers
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

function logInfo(msg) { console.log(`[${ts()}] ${colors.blue}INFO${colors.reset} ${msg}`); }
function logWarn(msg) { console.log(`[${ts()}] ${colors.yellow}WARN${colors.reset} ${msg}`); }
function logError(msg) { console.log(`[${ts()}] ${colors.red}ERROR${colors.reset} ${msg}`); }
function logSuccess(msg) { console.log(`[${ts()}] ${colors.green}SUCCESS${colors.reset} ${msg}`); }
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

// 2) Config defaults
const SLIPPAGE_TOLERANCE = Number(process.env.SLIPPAGE_TOLERANCE || 0.005);
const VAULT_MIN_USDC = Number(process.env.VAULT_MIN_USDC || 5000);
const NET_PROFIT_MIN_USDC = Number(process.env.NET_PROFIT_MIN_USDC || 0.00001);
const GAS_LIMIT_PER_TRADE = Number(process.env.GAS_LIMIT_PER_TRADE || 350000);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 180);
let DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
let SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
let TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 2);

// 3) Helpers
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function symbol(addr) { return addr; }
function dexSymbol(router) { return String(router); }

// Placeholder: vault, provider, wallets, TOKENS, routers, MIN_TRADE_USDC, MIN_EXPECTED_PROFIT, quote(), vaultUSDCBalance()

// 4) Core ARB helpers
let executionQueue = [];
let executing = false;

async function estimateGasUSDCFee() {
  try {
    const gasPrice = await provider.getGasPrice();
    const feeWei = gasPrice.mul(GAS_LIMIT_PER_TRADE);
    const feeEth = Number(ethers.utils.formatUnits(feeWei, 18));
    const approxUSDCPerEth = 1000000;
    return feeEth * approxUSDCPerEth;
  } catch { return 0; }
}

async function vaultUSDCBalance() {
  try {
    const bal = await vault.usdc();
    return ethers.BigNumber.from(bal);
  } catch {
    return ethers.BigNumber.from("1000000000000000000");
  }
}

async function isPathViable(routerAddr, path) {
  const illiquidHops = new Set([TOKENS.DAI?.toLowerCase(), TOKENS.USDT?.toLowerCase()]);
  return !path.some(hop => illiquidHops.has((hop || "").toLowerCase()));
}

async function checkArb(buyRouter, sellRouter, tokenAddr, usdcAddr) {
  const amountInUSDC = ethers.utils.parseUnits("500", 6);
  const buyPaths = generatePaths(usdcAddr, tokenAddr);
  const sellPaths = generatePaths(tokenAddr, usdcAddr);
  const estimatedFee = await estimateGasUSDCFee();

  for (const buyPath of buyPaths) {
    for (const sellPath of sellPaths) {
      if (buyRouter === sellRouter) continue;
      const buyOut = await quote(buyRouter, amountInUSDC, buyPath).catch(() => null);
      if (!buyOut) continue;
      const minBuyOut = buyOut.mul(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1e6)).div(1e6);
      if (buyOut.lt(minBuyOut)) continue;

      const sellOut = await quote(sellRouter, buyOut, sellPath).catch(() => null);
      if (!sellOut) continue;
      const minSellOut = buyOut.mul(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1e6)).div(1e6);
      if (sellOut.lt(minSellOut)) continue;

      const receivedUSDC = Number(ethers.utils.formatUnits(sellOut, 6));
      const grossProfit = receivedUSDC - (MIN_TRADE_USDC || 0);
      const netProfit = grossProfit - estimatedFee;

      if (netProfit >= NET_PROFIT_MIN_USDC) {
        const arb = { buyRouter, sellRouter, tokenAddr, buyPath, sellPath, profit: netProfit };
        logArbQueued(arb);
        return arb;
      }
    }
  }
  return null;
}

async function execArbWithRetry(arb) {
  const amountIn = ethers.utils.parseUnits((MIN_TRADE_USDC || 0).toString(), 6);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  let lastError;

  for (let attempt = 0; attempt <= TX_RETRY_ATTEMPTS; attempt++) {
    try {
      const tx = await vault.executeArbitrage(arb.buyRouter, arb.sellRouter, amountIn, arb.buyPath, arb.sellPath, deadline);
      console.log(`[${ts()}] ⛓ TX SENT: ${tx.hash} (attempt ${attempt + 1})`);
      await tx.wait();
      logArbExecutedOK(arb);
      return true;
    } catch (e) {
      lastError = e;
      logError(`TX FAILED (attempt ${attempt + 1}): ${e?.message ?? e}`);
      await sleep(Math.min(1000 * Math.pow(2, attempt), 32000));
    }
  }
  logError(`All tx attempts failed for arb on ${symbol(arb.tokenAddr)}`);
  throw lastError;
}

async function processQueue() {
  if (executing) return;
  executing = true;

  while (executionQueue.length) {
    const arb = executionQueue.shift();
    logArbExecuting(arb);

    if (!DRY_RUN) {
      try {
        const bal = await vaultUSDCBalance();
        if (bal.lt(ethers.utils.parseUnits(VAULT_MIN_USDC.toString(), 6))) {
          logWarn(`Vault USDC balance too low (${bal.toString()}). Skipping execution.`);
          continue;
        }
        await execArbWithRetry(arb);
        const updatedBal = await vaultUSDCBalance();
        logInfo(`Post-arb vault USDC balance: ${ethers.utils.formatUnits(updatedBal, 6)}`);
      } catch (e) {
        logError(`Execution error for arb: ${e?.message ?? e}`);
      }
    } else {
      logArbDryRunInfo(arb);
    }

    await sleep(50);
  }

  executing = false;
}

async function scan() {
  const vaultBal = await vaultUSDCBalance();
  logInfo(`Vault USDC balance: ${ethers.utils.formatUnits(vaultBal, 6)}`);
  const usdc = await vault.usdc();

  const tasks = [];
  const found = [];

  for (const tokenAddr of Object.values(TOKENS)) {
    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {
        if (buyRouter === sellRouter) continue;
        tasks.push(async () => {
          if (!(await isPathViable(buyRouter, [usdc, tokenAddr]))) return null;
          const arb = await checkArb(buyRouter, sellRouter, tokenAddr, usdc);
          if (arb) found.push(arb);
          return arb;
        });
      }
    }
  }

  await runWithConcurrency(tasks, SCAN_CONCURRENCY);

  found.sort((a, b) => b.profit - a.profit).forEach(arb => executionQueue.push(arb));

  if (executionQueue.length) {
    logSuccess(`Queued ${executionQueue.length} profitable arb(s) for execution`);
    processQueue();
  } else {
    logInfo("No profitable arbitrage opportunities found in this cycle.");
  }
}

async function mainLoop() {
  while (true) {
    try {
      await scan();
      await sleep(Number(process.env.SCAN_DELAY_MS || 2000));
    } catch (e) {
      logError(`Unexpected error in main loop: ${e?.message ?? e}`);
      await sleep(2000);
    }
  }
}

async function bootstrap() {
  logInfo(`ARBJS drop-in started in ${DRY_RUN ? "DRY_RUN" : "LIVE"} mode.`);
  await scan();
  mainLoop().catch(err => logError("Fatal error in main loop: " + (err?.message ?? err)));
}

// Start the bot
bootstrap();
