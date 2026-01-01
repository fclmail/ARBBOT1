// SPDX-License-Identifier: MIT
// arbitrage.js — Full ARB J's with decimal fixes applied

const { ethers } = require("ethers");
const { tokens, routers, contractAddress, provider } = require("./config"); // adjust paths

let scanInterval = null;
let isScanning = false;
let walletAddress = null;
let accumulatedProfit = 0;
let transactionHistory = [];

// -------------------------
// LOGGING
// -------------------------
function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// -------------------------
// UTILS
// -------------------------
async function updateBalances() {
    const vaultUSDC = await getContractUSDCBalance();
    log(`🏦 Vault USDC: ${vaultUSDC}`);
}

async function getContractUSDCBalance() {
    const usdc = new ethers.Contract(
        tokens.USDC.address,
        ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"],
        provider
    );
    const decimals = await usdc.decimals();
    const balance = await usdc.balanceOf(contractAddress);
    return Number(ethers.formatUnits(balance, decimals));
}

// -------------------------
// SCAN / ARBITRAGE
// -------------------------
function currentIntervalMs() {
    const sec = parseInt(process.env.SCAN_INTERVAL_SEC || "30", 10);
    return Math.max(0, Math.min(100, sec)) * 1000;
}

async function scanAndArbitrage() {
    if (!walletAddress) {
        log("Please connect your wallet first");
        return;
    }
    if (isScanning) return;
    isScanning = true;

    try {
        const minProfitPct = parseFloat(process.env.MIN_PROFIT_PCT || "0.01");
        const tradeAmount = parseFloat(process.env.TRADE_AMOUNT || "1"); // in USDC
        const slippagePct = parseFloat(process.env.SLIPPAGE_PCT || "0.15");
        const requireStatic = process.env.CALL_STATIC === "true";

        const amountIn = ethers.parseUnits(tradeAmount.toString(), 6); // USDC decimals = 6

        for (const [symbol, meta] of Object.entries(tokens)) {
            const token = meta.address;
            for (const [buyName, buyRouter] of Object.entries(routers)) {
                for (const [sellName, sellRouter] of Object.entries(routers)) {
                    if (buyName === sellName) continue;

                    try {
                        // -------------------------
                        // DECIMAL-FIXED GET AMOUNTS
                        // -------------------------
                        const buyOutRaw = await getAmountOut(buyRouter, token, amountIn, false);
                        const sellOutRaw = await getAmountOut(sellRouter, token, amountIn, false);

                        // Format amounts correctly according to token decimals
                        const tokenDecimals = meta.decimals || 18;
                        const buyOut = Number(ethers.formatUnits(buyOutRaw, tokenDecimals));
                        const sellOut = Number(ethers.formatUnits(sellOutRaw, tokenDecimals));

                        // Prices (USDC per 1 token)
                        const buyPrice = tradeAmount / buyOut;
                        const sellPrice = tradeAmount / sellOut;

                        // Profit calculations
                        const grossProfit = sellPrice - buyPrice;
                        const adjustedProfit = grossProfit * (1 - slippagePct / 100);
                        const profitPct = (adjustedProfit / buyPrice) * 100;

                        // CallStatic verification if enabled
                        let staticProfitPct = NaN;
                        if (requireStatic) {
                            const buyOutStaticRaw = await getAmountOut(buyRouter, token, amountIn, true);
                            const sellOutStaticRaw = await getAmountOut(sellRouter, token, amountIn, true);

                            const buyOutStatic = Number(ethers.formatUnits(buyOutStaticRaw, tokenDecimals));
                            const sellOutStatic = Number(ethers.formatUnits(sellOutStaticRaw, tokenDecimals));

                            const buyPriceStatic = tradeAmount / buyOutStatic;
                            const sellPriceStatic = tradeAmount / sellOutStatic;

                            staticProfitPct = ((sellPriceStatic - buyPriceStatic) / buyPriceStatic) * 100;
                        }

                        const profitable = adjustedProfit > minProfitPct;
                        const canAutoTrade = profitable && (!requireStatic || (requireStatic && staticProfitPct > minProfitPct));

                        // -------------------------
                        // LOG
                        // -------------------------
                        log(`🔍 ${buyName} ➜ ${sellName}`);
                        log(`📈 ${buyName} price: ${buyPrice.toFixed(6)} USDC/${symbol}`);
                        log(`📉 ${sellName} price: ${sellPrice.toFixed(6)} USDC/${symbol}`);
                        log(`💵 Gross profit: ${grossProfit.toFixed(6)} USDC`);
                        log(`💵 Adjusted profit: ${adjustedProfit.toFixed(6)} USDC`);
                        log(`${profitable ? '✅ MIN PROFIT satisfied' : '❌ Below minimum profit – not executing'}`);

                        // -------------------------
                        // EXECUTE TRADE IF PROFITABLE
                        // -------------------------
                        if (canAutoTrade && process.env.AUTO_TRADE === "true") {
                            await executeTrade(buyRouter, sellRouter, token, amountIn, symbol, profitPct);
                        }

                    } catch (err) {
                        log(`⚠️ ${symbol} ${buyName} -> ${sellName} failed: ${err.message}`);
                    }
                }
            }
        }

    } catch (error) {
        log(`⚠️ Scan failed: ${error.message}`);
    } finally {
        isScanning = false;
        await updateBalances();
        log("Scan completed");
    }
}

// -------------------------
// EXECUTE TRADE
// -------------------------
async function executeTrade(buyRouter, sellRouter, token, amountIn, symbol, profitPct) {
    try {
        const batchCount = Math.min(parseInt(process.env.BATCH_COUNT || "1", 10), 100);
        log(`🚀 Executing arbitrage for ${symbol} (${profitPct.toFixed(2)}%) x${batchCount}...`);

        for (let i = 0; i < batchCount; i++) {
            const vaultBefore = await getContractUSDCBalance();

            const tx = await contract.executeArbitrage(
                buyRouter,
                sellRouter,
                token,
                amountIn,
                { gasLimit: 1000000 }
            );
            log(`📤 Transaction ${i + 1}/${batchCount} sent: ${tx.hash}`);
            const receipt = await tx.wait();

            const vaultAfter = await getContractUSDCBalance();
            const profit = vaultAfter - vaultBefore;

            if (!process.env.POSITIVE_ONLY || profit > 0) {
                if (profit > 0) {
                    accumulatedProfit += profit;
                    log(`💰 Profit this tx: ${profit.toFixed(6)} USDC | Accumulated: ${accumulatedProfit.toFixed(6)} USDC`);
                }
            }
        }

    } catch (err) {
        log(`⚠️ Arbitrage failed for ${symbol}: ${err.message}`);
    }
}

// -------------------------
// MOCK / HELPER: getAmountOut
// -------------------------
async function getAmountOut(router, token, amountIn, useCallStatic) {
    // placeholder; in your real ARB bot this queries DEX
    return ethers.parseUnits("1", 18); // token decimals assumed 18
}

// -------------------------
// MAIN LOOP
// -------------------------
async function startBot() {
    log("Polygon Arb Bot Started");
    setInterval(scanAndArbitrage, currentIntervalMs());
}

startBot();
