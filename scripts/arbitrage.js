/* ================= CONFIG ================= */

const FLASH_AMOUNT_USDC = 10_000;
const FLASH_AMOUNT = ethers.parseUnits("10000", 6);

// AAVE V3 Polygon premium ≈ 0.05% (0.0005)
const FLASH_PREMIUM_RATE = 0.0005;

// Minimum PROFIT in USDC (not percent)
const MIN_PROFIT_USDC = 0.000001; // adjustable

/* ================= ARBITRAGE ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();

  // 1️⃣ Simulate FULL 10k buy
  let bestBuyOut, bestBuyPath;

  for (const p of buildPaths(usdc, tokenAddr)) {
    const out = await quote(buyRouter, FLASH_AMOUNT, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestBuyOut) return;

  // 2️⃣ Simulate FULL 10k sell
  let bestSellOut, bestSellPath;

  for (const p of buildSellPaths(usdc, tokenAddr)) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }

  if (!bestSellOut) return;

  const finalUSDC = Number(ethers.formatUnits(bestSellOut, 6));

  const premiumCost = FLASH_AMOUNT_USDC * FLASH_PREMIUM_RATE;
  const rawProfit = finalUSDC - FLASH_AMOUNT_USDC;
  const netAfterPremium = rawProfit - premiumCost;

  if (netAfterPremium <= MIN_PROFIT_USDC) return;

  console.log(`🔥 PROFITABLE FLASH FOUND`);
  console.log(`Gross Profit: ${rawProfit.toFixed(6)} USDC`);
  console.log(`Premium Cost: ${premiumCost.toFixed(6)} USDC`);
  console.log(`Net Profit: ${netAfterPremium.toFixed(6)} USDC`);

  try {
    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      FLASH_AMOUNT,
      bestBuyPath,
      bestSellPath,
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );

    console.log("⏳ Waiting confirmation...");
    const receipt = await tx.wait();

    console.log("✅ FLASH SUCCESS");
    console.log("Transaction Hash:", receipt.hash);
  } catch (err) {
    console.log("❌ Flash reverted:", err.reason || err.message);
  }
}
