// ================= ARB BOT DROP-IN =================
const { getVaultBalance, getWalletBalance, quote, executeFlashBatch } = require('./arbUtils');
const TOKENS = require('./tokens'); // USDC, WMATIC, WETH, USDT, DAI

async function scanArb(tokenAddr, buyRouter, sellRouter, usdc) {
  const vaultBalance = await getVaultBalance(usdc);
  const walletBalance = await getWalletBalance(TOKENS.WMATIC);

  console.log(`[${new Date().toISOString()}] ================= NEW SCAN =================`);
  console.log(`[${new Date().toISOString()}] Vault USDC Balance: ${vaultBalance}`);
  console.log(`[${new Date().toISOString()}] Wallet MATIC Balance: ${walletBalance}`);

  // ------------------- MICRO DETECTION -------------------
  const microProfit = await quote(buyRouter, tokenAddr, [tokenAddr, usdc]);
  if (!microProfit || microProfit < 0.02) {
    console.log(`[${new Date().toISOString()}] Skipped — not scalable past 0.02 USDC`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Scalable trade detected for ${microProfit.toFixed(2)} USDC profit`);

  // ------------------- HOP PATHS -------------------
  let bestBuyOut = null, bestBuyPath;
  for (const path of [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ]) {
    const out = await quote(buyRouter, tokenAddr, path);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = path;
    }
  }
  if (!bestBuyOut) return null;

  let bestSellOut, bestSellPath;
  for (const path of [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ]) {
    const out = await quote(sellRouter, bestBuyOut, path);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = path;
    }
  }
  if (!bestSellOut) return null;

  // ------------------- BINARY SIZE OPTIMIZATION -------------------
  const testSizes = [0.02, 0.04, 0.20, 0.40]; // Scales
  let optimalSize = null;

  for (const size of testSizes) {
    const result = await quote(sellRouter, bestBuyOut * size / microProfit, bestSellPath);
    if (result >= 0.000001) { // Smart contract enforced min profit
      console.log(`[${new Date().toISOString()}] Testing size: ${size.toFixed(2)} USDC → PASS`);
      optimalSize = size;
    } else {
      console.log(`[${new Date().toISOString()}] Testing size: ${size.toFixed(2)} USDC → FAIL (minProfit revert)`);
    }
  }

  if (!optimalSize) {
    console.log(`[${new Date().toISOString()}] No profitable trades found`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Optimal trade size: ${optimalSize.toFixed(2)} USDC`);

  // ------------------- EXECUTE FLASH BATCH -------------------
  const txHash = await executeFlashBatch(buyRouter, sellRouter, bestBuyPath, bestSellPath, optimalSize);
  console.log(`[${new Date().toISOString()}] Batch flash sent: ${txHash}`);
  // Simulate confirmation
  await new Promise(r => setTimeout(r, 15000));
  console.log(`[${new Date().toISOString()}] Batch flash confirmed — profits deposited to vault`);
  console.log(`[${new Date().toISOString()}] Completed trade with ${optimalSize.toFixed(2)} USDC profit`);
}

// Example usage
scanArb('0xTokenAddress', '0xBuyRouter', '0xSellRouter', TOKENS.USDC);
