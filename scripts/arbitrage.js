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
    `[${ts()}] ${colors.cyan}DRY_RUN${colors.reset} | Would execute arb: ${arb.buyPath.map(p => symbol(p)).join("->")} -> ${arb.sellPath.map(p => symbol(p)).join("->")} | NetProfit ${arb.profit.toFixed(6)} USDC`  
  );  
}  

// ===== 2) Config defaults =====  
const SLIPPAGE_TOLERANCE = Number(process.env.SLIPPAGE_TOLERANCE || 0.005); // 0.5%  
const VAULT_MIN_USDC = Number(process.env.VAULT_MIN_USDC || 5000);  
const NET_PROFIT_MIN_USDC = Number(process.env.NET_PROFIT_MIN_USDC || 0.01); // minimum profit  
const GAS_LIMIT_PER_TRADE = Number(process.env.GAS_LIMIT_PER_TRADE || 350000);  
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 180);  
let DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";  
let SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);  
let TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 2);  

// ===== 3) Helpers (continued) =====  
function symbol(addr) {  
  return addr; // You can replace with a mapping to friendly names if desired  
}  
function dexSymbol(router) {  
  return String(router);  
}  

// ===== 4) Vault balance fetch (mock/placeholder) =====  
async function vaultUSDCBalance() {  
  try {  
    if (typeof vault !== "undefined" && vault?.usdc) {  
      const bal = await vault.usdc();  
      return ethers.BigNumber.from(bal);  
    }  
    // Fallback for testing  
    return ethers.BigNumber.from("1000000000"); // 1,000 USDC (6 decimals)  
  } catch {  
    return ethers.BigNumber.from("1000000000");  
  }  
}  

// ===== 5) Gas estimation placeholder =====  
async function estimateGasUSDCFee() {  
  try {  
    if (!provider) return 0;  
    const gasPrice = await provider.getGasPrice();  
    const feeWei = gasPrice.mul(GAS_LIMIT_PER_TRADE);  
    const feeEth = Number(ethers.utils.formatUnits(feeWei, 18));  
    const approxUSDCPerEth = 1000000; // 1 ETH ≈ 1,000,000 USDC (mock)  
    return feeEth * approxUSDCPerEth;  
  } catch {  
    return 0;  
  }  
}  

// ===== 6) Path viability check =====  
async function isPathViable(routerAddr, path) {  
  const illiquidHops = new Set([TOKENS.DAI?.toLowerCase(), TOKENS.USDT?.toLowerCase()]);  
  for (const hop of path) {  
    if (illiquidHops.has((hop || "").toLowerCase())) return false;  
  }  
  return true;  
}  

// ===== 7) Check for profitable arbitrage =====  
async function checkArb(buyRouter, sellRouter, tokenAddr, usdcAddr) {  
  const amountInUSDC = ethers.utils.parseUnits("500", 6);  
  const buyPaths = generatePaths(usdcAddr, tokenAddr);  
  const sellPaths = generatePaths(tokenAddr, usdcAddr);  
  const estimatedFeeUSDC = await estimateGasUSDCFee();  

  for (const buyPath of buyPaths) {  
    for (const sellPath of sellPaths) {  
      if (buyRouter === sellRouter) continue;  
      const buyOut = await quote(buyRouter, amountInUSDC, buyPath).catch(() => null);  
      if (!buyOut) continue;  

      const minBuyOut = buyOut  
        .mul(ethers.BigNumber.from(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1e6)))  
        .div(1e6);  
      if (buyOut.lt(minBuyOut)) continue;  

      const sellOut = await quote(sellRouter, buyOut, sellPath).catch(() => null);  
      if (!sellOut) continue;  

      const minSellOut = buyOut  
        .mul(ethers.BigNumber.from(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1e6)))  
        .div(1e6);  
      if (sellOut.lt(minSellOut)) continue;  

      const receivedUSDC = Number(ethers.utils.formatUnits(sellOut, 6));  
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

// ===== 8) Execute arbitrage with retry (continued) =====  
async function execArbWithRetry(arb) {  
  const amountIn = ethers.utils.parseUnits((MIN_TRADE_USDC || 0).toString(), 6);  
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;    let lastError;  
  for (let attempt = 0; attempt <= TX_RETRY_ATTEMPTS; attempt++) {  
    try {  
      if (!vault?.executeArbitrage) throw new Error("vault.executeArbitrage not defined");  
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
      await sleep(Math.min(1000 * Math.pow(2, attempt), 32000));  
    }  
  }  
  logError(`All tx attempts failed for arb on ${symbol(arb.tokenAddr)}`);  
  throw lastError;  
}  

// ===== 9) Execution queue management =====  
let executionQueue = [];  
let executing = false;  

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

// ===== 10) Scan logic =====  
async function scan() {  
  const vaultBal = await vaultUSDCBalance();  
  logInfo(`Vault USDC balance: ${ethers.utils.formatUnits(vaultBal, 6)}`);  
  const usdc = await vault.usdc?.();  
  const tokensList = Object.values(TOKENS || {}); // adapt to your TOKENS map  
  const routersList = Object.values(routers || {}); // adapt to your routers map  

  const tasks = [];  
  const found = [];  

  for (const tokenAddr of tokensList) {  
    for (const buyRouter of routersList) {  
      for (const sellRouter of routersList) {  
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

  // Run tasks with concurrency  
  await runWithConcurrency(tasks, SCAN_CONCURRENCY);  

  found.sort((a, b) => b.profit - a.profit).forEach(arb => executionQueue.push(arb));  

  if (executionQueue.length) {  
    logSuccess(`Queued ${executionQueue.length} profitable arb(s) for execution`);  
    processQueue();  
  } else {  
    logInfo("No profitable arbitrage opportunities found in this cycle.");  
  }  
}  

// ===== 11) Main loop =====  
async function mainLoop() {  
  while (true) {  
    try {  
      await scan();  
      const cadenceMs = Number(process.env.SCAN_DELAY_MS || 2000);  
      await sleep(cadenceMs);  
    } catch (e) {  
      logError(`Unexpected error in main loop: ${e?.message ?? e}`);  
      await sleep(2000);  
    }  
  }  
}  

// ===== 12) Bootstrap/startup (final) =====
async function bootstrap() {
  logInfo(`ARBJS drop-in started in ${DRY_RUN ? "DRY_RUN" : "LIVE"} mode.`);
  // Initial scan to seed the queue
  await scan();

  // Start the continuous main loop
  mainLoop().catch((err) =>
    logError("Fatal error in main loop: " + (err?.message ?? err))
  );
}

// Run bootstrap
bootstrap();

// ===== End of ARBJS FULL DROP-IN =====
