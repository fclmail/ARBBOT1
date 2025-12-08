// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) 
                   || { address: tokenAddr, decimals: 18 };
  const buyName = Object.entries(routers).find(([k,v]) => v.toLowerCase() === buyRouter.toLowerCase())[0];
  const sellName = Object.entries(routers).find(([k,v]) => v.toLowerCase() === sellRouter.toLowerCase())[0];

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    if (amountUSDC < MIN_TRADE_USDC || amountUSDC > before) return;

    const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
    const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    const expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
    const expectedProfitPct = (expectedProfitUSDC / buyPrice) * 100;

    console.log(`💹 DEX: ${buyName} → ${sellName} | Token: ${tokenAddr}`);
    console.log(`📈 Buy Price: ${fmt(buyPrice)} | Sell Price: ${fmt(sellPrice)} | Expected Profit: ${fmt(expectedProfitUSDC)} USDC`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT || expectedProfitPct > MAX_PROFIT_PCT || expectedProfitUSDC <= 0) {
      console.log("❌ PREVENTED — Not profitable or exceeds max profit cap");
      return;
    }

    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) ||
        !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed");
      return;
    }

    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [
          buyRouter, sellRouter, tokenAddr,
          ethers.parseUnits(amountUSDC.toString(), 6),
        ]),
        from: wallet ? wallet.address : undefined
      });
      console.log("🔬 Simulation PASS ✅");
    } catch {
      console.log("❌ SIM FAILED — would revert");
      return;
    }

    if (DRY_RUN) return;

    const gasEstimate = await arbContract.estimateGas.executeArbitrage(
      buyRouter, sellRouter, tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6)
    ).catch(() => null);

    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6),
      { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined }
    );
    console.log(`🔁 TX SENT — ${tx.hash}`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ TX failed");
      return;
    }
    console.log(`✅ Trade SUCCESS — ${receipt.transactionHash}`);

    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    const netProfit = after - before;
    if (netProfit <= 0) {
      console.log("⚠️ No net profit — ignored");
      return;
    }

    console.log(`💰 REAL NET PROFIT: ${fmt(netProfit)} USDC`);
    cumulativeProfit += netProfit;

    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}
