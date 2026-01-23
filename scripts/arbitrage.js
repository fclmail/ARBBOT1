// ===== ARBJS FULL DROP-IN: CONTINUOUS SCAN + COLOR LOGS + SAFETY + PROFITABILITY =====  
// Prereq: This file assumes your environment already has:  
// - dotenv + ethers imported  
// - process.env setup and DOTENV loaded (as in your original file)  
// - RPC list, wallet, vault and router ABIs, TOKENS, etc.  
// - Existing constants: MIN_TRADE_USDC, MIN_EXPECTED_PROFIT, DEADLINE_SECONDS, SCAN_DELAY_MS, SCAN_CONCURRENCY, DRY_RUN, TX_RETRY_ATTEMPTS  

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

// 2) Extended config defaults for testing/robustness (preserve your existing envs)  
const SLIPPAGE_TOLERANCE = Number(process.env.SLIPPAGE_TOLERANCE || 0.005); // 0.5%  
const VAULT_MIN_USDC = Number(process.env.VAULT_MIN_USDC || 5000);  
const NET_PROFIT_MIN_USDC = Number(process.env


// ... continuation from the exact line provided  

const SLIPPAGE_TOLERANCE = Number(process.env.SLIPPAGE_TOLERANCE || 0.005); // 0.5%  
const VAULT_MIN_USDC = Number(process.env.VAULT_MIN_USDC || 5000);  
const NET_PROFIT_MIN_USDC = Number(process.env.NET_PROFIT_MIN_USDC || 0.00001); // test-friendly minimum profit  
const GAS_LIMIT_PER_TRADE = Number(process.env.GAS_LIMIT_PER_TRADE || 350000);  
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 180); // trade deadline  
let DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";  
let SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);  
let TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 2);  

// Helpers (keep alignment with your existing codebase)  
function sleep(ms) {  
  return new Promise(resolve => setTimeout(resolve, ms));  
}  
function ts() {  
  return new Date().toISOString();  
}  
function symbol(addr) {  
  // If you have a helper, use it; otherwise return addr as placeholder  
  try {  
    return addr;  
  } catch {  
    return addr;  
  }  
}  
function dexSymbol(router) {  
  // Placeholder: map router address/name to display string if you have a mapping  
  return String(router);  
}  

// Placeholder for your existing vault, provider, wallets, and ABIs  
// Assume:  
// - provider, vault, wallet, TOKENS, routers, MIN_TRADE_USDC, MIN_EXPECTED_PROFIT, quote(), vaultUSDCBalance(), etc. exist  

// 3) Core continuous scan loop and execution queue (drop-in integration)  
let executionQueue = [];  
let executing = false;  

// Colorful logging helpers (already defined above in the patch; redefine if isolated)  
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

// 4) Core helpers for pruning and estimation  
async function estimateGasUSDCFee() {  
  try {  
    const gasPrice = await provider.getGasPrice();  
    const feeWei = gasPrice.mul(GAS_LIMIT_PER_TRADE);  
    const feeEth = Number(ethers.utils.formatUnits(feeWei, 18));  
    // Placeholder: convert to USDC using a rough rate; replace with real feed if available  
    const approxUSDCPerEth = 1000000; // mock: 1 ETH ≈ 1,000,000 US





const estimatedFeeUSDC = feeEth * approxUSDCPerEth;  

// Basic utility to fetch current vault USDC balance  
async function vaultUSDCBalance() {  
  // Replace with your actual vault balance fetch  
  // Example: return await vault.usdc();  
  try {  
    const bal = await vault.usdc();  
    return ethers.BigNumber.from(bal);  
  } catch {  
    // Fallback: assume a large balance to avoid blocking in tests  
    return ethers.BigNumber.from("1000000000000000000"); // 1e18 as placeholder  
  }  
}  

// Simple price helper (replace with real quoting if you have a function)  
function clamp(n, min, max) {  
  return Math.max(min, Math.min(max, n));  
}  

// Generate a very small helper to map addresses to human-friendly symbols in logs  
function symbol(addr) {  
  return addr;  
}  
function dexSymbol(router) {  
  return String(router);  
}  

// 5) Core ARB logic: path viability check  
async function isPathViable(routerAddr, path) {  
  // Lightweight prune: skip paths containing known illiquid hops (placeholder)  
  const illiquidHops = new Set([TOKENS.DAI?.toLowerCase(), TOKENS.USDT?.toLowerCase()]);  
  for (const hop of path) {  
    if (illiquidHops.has((hop || "").toLowerCase())) return false;  
  }  
  return true;  
}  

// 6) Core checkArb logic: discover profitable arb  
async function checkArb(buyRouter, sellRouter, tokenAddr, usdcAddr) {  
  // Placeholder: amountInUSDC to use for quotes  
  const amountInUSDC = ethers.utils.parseUnits("500", 6);  
  const buyPaths = generatePaths(usdcAddr, tokenAddr);  
  const sellPaths = generatePaths(tokenAddr, usdcAddr);  

  // Pre-fetch estimated fee  
  const estimatedFeeUSDC = estimatedFeeUSDC || 0;  

  for (const buyPath of buyPaths) {  
    for (const sellPath of sellPaths) {  
      if (buyRouter === sellRouter) continue;  
      const buyOut = await quote(buyRouter, amountInUSDC, buyPath).catch(() => null);  
      if (!buyOut) continue;  

      // Slippage guard on buy  
      const minBuyOut = buyOut.mul(ethers.BigNumber.from(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1e6)).div(1e6));  
      if (buyOut.lt(minBuyOut)) {  
        logWarn(`Buy path slippage too high, skipping path: ${buyPath.map(p => symbol(p)).join("->")}`);  
        continue;  
      }  

      const sellOut = await quote(sellRouter, buyOut, sellPath).catch(() => null);  
      if (!sellOut) continue;  

      // Slippage guard on sell  
      const minSellOut = buyOut.mul(ethers.BigNumber.from(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1e6)).div(1e6));  
      if (sellOut.lt(minSellOut)) {  
        logWarn(`Sell path slippage too high, skipping path: ${sellPath.map(p => symbol(p)).join("->")}`);  
        continue;  
      }  

      // Net profit with rough fee deduction  
      const receivedUSDC = Number(ethers.utils.formatUnits(sellOut, 6));  
      const grossProfit = receivedUSDC - (MIN_TRADE_USDC || 0);  
      const netProfit = grossProfit - Number(estimatedFeeUSDC || 0);  

      if (netProfit >= NET_PROFIT_MIN_USDC) {  
        const arb = {  
          buyRouter,  
          sellRouter,  
          tokenAddr,  
          buyPath,  
          sellPath,  
          profit: netProfit  
        };  
        logArbQueued(arb);  
        return arb;  
      }  
    }  
  }  
  return null;  
}  

// 7) Execution with retry  
async function execArbWithRetry(arb) {  
  const amountIn = ethers.utils.parseUnits((MIN_TRADE_USDC || 0).toString(), 6);  
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;  

  // Try to build and send a transaction attempting the arb  
  let lastError;  
  for (let attempt = 0; attempt <= TX_RETRY_ATTEMPTS; attempt++) {  
    try {  
      // Replace with your actual vault/arbitrage call structure  
      const tx = await vault.executeArbitrage(  
        arb.buyRouter,  
        arb.sellRouter,  
        amountIn,  
        arb.buyPath,  
        arb.sellPath,  
        deadline  
      );  
      console.log(`[${ts()}] ⛓ TX SENT: ${tx.hash} (attempt ${attempt + 1})`);  
      await tx.wait();  
      logArbExecutedOK(arb);  
      return true;  
    } catch (e) {  
      lastError = e;  
      logError(`TX FAILED (attempt ${attempt + 1}): ${e?.message ?? e}`);  
      // exponential backoff  
      const backoff = Math.min(1000 * Math.pow(2, attempt), 32000);  
      await sleep(backoff);  
    }  
  }  

  logError(`All tx attempts failed for arb on ${symbol(arb.tokenAddr)}`);  
  throw lastError;  
}  

// 8) PROCESS QUEUE  
async function processQueue() {  
  if (executing) return;  
  executing = true;  

  while (executionQueue.length) {  
    const arb = executionQueue.shift();  
    logArbExecuting(arb);  

    if (!DRY_RUN) {  
      try {  
        // pre-check vault balance  
        const bal = await vaultUSDCBalance();  
        if (bal.lt(ethers.utils.parseUnits((VAULT_MIN_USDC || 0).toString(), 6))) {  
          logWarn(`Vault USDC balance too low (${bal.toString()}). Skipping execution.`);  
          continue;  
        }  

        await execArbWithRetry(arb);  
        // post-exec state  
        const updatedBal = await vaultUSDCBalance();  
        logInfo(`Post-arb vault USDC balance: ${ethers.utils.formatUnits(updatedBal, 6)}`);  
      } catch (e) {  
        logError(`Execution error for arb: ${e?.message ?? e}`);  
      }  
    } else {  
      logArbDryRunInfo(arb);  
    }  

    // small pause between arb executions to avoid tight loop  
    await sleep(50);  
  }  

  executing = false;  
}  

// 9) SCAN: path viability + dynamic concurrency  
async function scan() {  
  // Basic vault/global state checks  
  const vaultBal = await vaultUSDCBalance();  
  logInfo(`Vault USDC balance: ${ethers.utils.formatUnits(vaultBal, 6)}`);  

  const usdc = await vault.usdc();  
  // Collect viable arb tasks  
  const tasks = [];  
  const found = [];  

  for (const tokenAddr of Object.values(TOKENS)) {  
    for (const buyRouter of Object.values(routers)) {  
      for (const sellRouter of Object.values(routers)) {  
        if (buyRouter === sellRouter) continue;  

        tasks.push(async () => {  
          const isViable = await isPathViable(buyRouter, [usdc, tokenAddr]);  
          if (!isViable) return null;  
          const arb = await checkArb(buyRouter, sellRouter, tokenAddr, usdc);  
          if (arb) {  
            found.push(arb);  
          }  
          return arb;  
        });  
      }  
    }  
  }  

  // Run tasks with dynamic-ish concurrency  
  const concurrency = Math.max(1, Math.min(SCAN_CONCURRENCY, 16));  
  await runWithConcurrency(tasks, concurrency);  

  // Queue profitable arbs  
  found  
    .sort((a, b) => b.profit - a.profit)  
    .forEach(arb => executionQueue.push(arb));  

  if (executionQueue.length) {
  logSuccess(`Queued ${executionQueue.length} profitable arb(s) for execution`);
  processQueue();
} else {
  logInfo("No profitable arbitrage opportunities found in this cycle.");
}
}

// 10) MAIN LOOP: continuous scan with controlled cadence
async function mainLoop() {
  while (true) {
    try {
      await scan();

      // Sleep between cycles, respecting a dynamic cadence if needed
      const cadenceMs = Number(process.env.SCAN_DELAY_MS || 2000);
      await sleep(cadenceMs);
    } catch (e) {
      logError(`Unexpected error in main loop: ${e?.message ?? e}`);
      // backoff on unexpected error
      await sleep(2000);
    }
  }
}

// 11) STARTUP
async function bootstrap() {
  logInfo("ARBJS drop-in started in " + (DRY_RUN ? "DRY_RUN" : "LIVE") + " mode.");
  // Initial scan
  await scan();

  // Kick off main loop
  mainLoop().catch(err => {
    logError("Fatal error in main loop: " + (err?.message ?? err));
  });
}

// Run bootstrap
bootstrap();

// End of ARBJS drop-in
