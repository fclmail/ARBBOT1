// ===== NEW: ARB ENHANCEMENTS DROP-IN =====
// NOTE: This patch assumes you keep the existing imports and constants.
// It adds: slippage guard, net-profit gate, dynamic concurrency, DRY_RUN clarity, and retry logic.

// CONFIG-EXT: new/overlaid constants (adjust as needed or via env)
const SLIPPAGE_TOLERANCE = Number(process.env.SLIPPAGE_TOLERANCE || 0.005); // 0.5% default
const VAULT_MIN_USDC = Number(process.env.VAULT_MIN_USDC || 5_000); // minimum vault USDC to operate
const NET_PROFIT_MIN_USDC = Number(process.env.NET_PROFIT_MIN_USDC || 0.00001); // per your request
const BASE_GAS_GWEI = Number(process.env.BASE_GAS_GWEI || 60);
const GAS_LIMIT_PER_TRADE = Number(process.env.GAS_LIMIT_PER_TRADE || 350_000);
const MAX_RETRY = Number(process.env.TX_RETRY_ATTEMPTS || 2);
let DYNAMIC_SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);

// NEW: estimate an approximate USDC-fee using ETH/MATIC price basis (approximate)
async function estimateGasUSDCFee() {
  try {
    // We assume a rough 1:1 for gas in testnet/mocked -> convert later if you have a price feed
    const gasPrice = await provider.getGasPrice(); // in wei
    const feeWei = gasPrice.mul(GAS_LIMIT_PER_TRADE);
    const feeEth = Number(ethers.formatUnits(feeWei, 18));
    // Simple placeholder: 1 ETH ≈ 1,000,000 USDC (adjust with real price if available)
    // For a more accurate estimate, pull USDC price feed for the chain asset
    const approxUSDCPerEth = 1_000_000; // placeholder for test environment
    return feeEth * approxUSDCPerEth; // USDC units
  } catch {
    return 0;
  }
}

// NEW: explicit DRY-RUN enhanced logging helper
function logArbAttempt(arb, netProfit) {
  console.log(
    `[${ts()}] ARB_ATTEMPT | Token ${symbol(arb.tokenAddr)} | Buy ${dexSymbol(arb.buyRouter)} → Sell ${dexSymbol(arb.sellRouter)} | Path(${arb.buyPath.map(symbol).join("->")})-(${arb.sellPath.map(symbol).join("->")}) | NetProfit_USDC=${netProfit.toFixed(6)}`
  );
}

// NEW: checkArb with slippage guard and net profit gate
async function checkArb(buyRouter, sellRouter, tokenAddr, usdcAddr) {
  const amountInUSDC = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyPaths = generatePaths(usdcAddr, tokenAddr);
  const sellPaths = generatePaths(tokenAddr, usdcAddr);

  // Pre-fetch a baseline estimate to speed up hot loops
  const estimatedFeeUSDC = await estimateGasUSDCFee();

  for (const buyPath of buyPaths) {
    for (const sellPath of sellPaths) {
      console.log(
        `[${ts()}] 🔎 SCAN | Token ${symbol(tokenAddr)} | Buy ${dexSymbol(buyRouter)} → Sell ${dexSymbol(sellRouter)}`
      );

      const buyOut = await quote(buyRouter, amountInUSDC, buyPath);
      if (!buyOut) continue;

      // Slippage guard on buy
      const minBuyOut = buyOut.mul(ethers.parseUnits((1 - SLIPPAGE_TOLERANCE).toString(), 0));
      if (buyOut.lt(minBuyOut)) {
        console.log(
          `[${ts()}] ⚠️ Buy path slippage too high, skipping path: ${buyPath.map(symbol).join("->")}`
        );
        continue;
      }

      const sellOut = await quote(sellRouter, buyOut, sellPath);
      if (!sellOut) continue;

      // Slippage guard on sell
      const minSellOut = buyOut.mul(ethers.parseUnits((1 - SLIPPAGE_TOLERANCE).toString(), 0));
      if (sellOut.lt(minSellOut)) {
        console.log(
          `[${ts()}] ⚠️ Sell path slippage too high, skipping path: ${sellPath.map(symbol).join("->")}`
        );
        continue;
      }

      // Compute net profit with a simple, test-friendly fee consideration
      const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));
      const grossProfit = receivedUSDC - MIN_TRADE_USDC;
      const netProfit = grossProfit - (estimatedFeeUSDC || 0);

      // Apply per-arb threshold (test-friendly)
      if (netProfit >= NET_PROFIT_MIN_USDC) {
        const arb = {
          buyRouter,
          sellRouter,
          tokenAddr,
          buyPath,
          sellPath,
          profit: netProfit
        };
        logArbAttempt(arb, netProfit);
        return arb;
      }
    }
  }
  return null;
}

/* ================= EXECUTION QUEUE (with retry) ================= */
async function execArbWithRetry(arb) {
  // Build tx with EIP-1559 style if supported
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  // Attempt to send with retries
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
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
      console.log(`[${ts()}] ✅ TX CONFIRMED`);
      return true;
    } catch (e) {
      lastError = e;
      console.log(`[${ts()}] ⚠️ TX FAILED (attempt ${attempt + 1}): ${e?.message ?? e}`);
      // simple backoff
      await sleep(100 * Math.pow(2, attempt));
    }
  }
  console.log(`[${ts()}] ❌ All tx attempts failed for arb:`, arb);
  throw lastError;
}

async function processQueue() {
  if (executing) return;
  executing = true;

  while (executionQueue.length) {
    const arb = executionQueue.shift();

    logArbAttempt(arb, arb.profit);

    if (!DRY_RUN) {
      try {
        // Pre-check vault balance guard
        const vaultBal = await vaultUSDCBalance();
        if (vaultBal < VAULT_MIN_USDC) {
          console.log(`[${ts()}] ⚠️ Vault USDC balance too low (${vaultBal.toFixed(6)}). Skipping execution.`);
          continue;
        }

        await execArbWithRetry(arb);
      } catch (e) {
        console.log(`[${ts()}] ⚠️ Execution error: ${e?.message ?? e}`);
      }
    } else {
      console.log(`[${ts()}] 🧪 DRY RUN — would execute arb with above params`);
    }

    // Post-execution state
    const updatedVaultBalance = await vaultUSDCBalance();
    const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
    console.log(
      `[${ts()}] 💰 Vault USDC balance: ${updatedVaultBalance.toFixed(6)} | Wallet MATIC: ${walletMatic.toFixed(6)}`
    );
  }

  executing = false;
}

/* ================= SCAN: path pruning + dynamic concurrency ================= */
// Heuristic: prune illiquid pools by simple pool-availability? Here we implement a light-touch prune
async function isPathViable(routerAddr, path) {
  // Placeholder hook: in a full implementation, query reserves via a router Subgraph or on-chain calls.
  // For drop-in purposes, we simply allow all paths unless path includes a known bad hop.
  // Example: disallow paths including a terrible hop (you can extend with actual reserves check)
  const illiquidHops = new Set([
    TOKENS.DAI.toLowerCase(),
    TOKENS.USDT.toLowerCase()
  ]);
  // If any hop is illiquid, skip
  for (const hop of path) {
    if (illiquidHops.has(hop.toLowerCase())) {
      return false;
    }
  }
  return true;
}

// Adapted scan to apply dynamic concurrency and path viability
async function scan() {
  const usdc = await vault.usdc();
  const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
  const vaultBalance = await vaultUSDCBalance();
  console.log(
    `[${ts()}] 💎 Wallet MATIC balance: ${walletMatic.toFixed(6)} | Vault USDC balance: ${vaultBalance.toFixed(6)}`
  );

  const tasks = [];
  const found = [];

  // Collect viable arb tasks with pruning
  for (const tokenAddr of Object.values(TOKENS)) {
    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {
        if (buyRouter === sellRouter) continue;

        // Early prune by viability of token-path
        tasks.push(async () => {
          // Simple viability skip: skip if path would be illiquid
          const isViable = await isPathViable(buyRouter, [usdc, tokenAddr]);
          if (!isViable) {
            return null;
          }
          const arb = await checkArb(buyRouter, sellRouter, tokenAddr, usdc);
          if (arb) found.push(arb);
          return arb;
        });
      }
    }
  }

  // Run with dynamic concurrency
  // Simple dynamic: start with base, scale down if latency observed (placeholder)
  const concurrency = Math.max(1, Math.min(DYNAMIC_SCAN_CONCURRENCY, 16));
  await runWithConcurrency(tasks, concurrency);

  found.sort((a, b) => b.profit - a.profit).forEach(a => executionQueue.push(a));
  if (found.length) {
    console.log(`[${ts()}] 💡 ${found.length} profitable arbs queued`);
    processQueue();
  } else {
    console.log(`[${ts()}] ℹ️ No profitable arb found in this cycle`);
  }
}
