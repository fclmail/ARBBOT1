// arbitrage-hardcoded-vault-live-protected-fixed-final-multiamounts.js
// Drop-in replacement for your ARBBOT1 runner with robust estimate/call fallbacks,
// retries, WMATIC->USDC caching, and a sweep over specified trade amounts.
// Uses Ethers v6
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true" || false;
console.log(
    DRY_RUN
        ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS"
        : "🚀 LIVE MODE ENABLED — REAL TRADES WILL EXECUTE"
);

// RPCS: comma-separated env or single RPC
const RPC_URLS = (process.env.RPC_URLS || (process.env.RPC_URL || "https://polygon-rpc.com")).split(",");
let provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
let wallet = new Wallet(process.env.PRIVATE_KEY || "", provider);
if (!process.env.PRIVATE_KEY && !DRY_RUN) throw new Error("PRIVATE_KEY required for live mode");

// ---------- HARDCODED VAULT ----------
const VAULT_CONTRACT = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // provided by you

// Safety parameters
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.0005); // percent
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.005); // tiny test trades allowed
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.5); // 0.5% slippage tolerance
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001); // USDC expected profit (incl gas)
const GAS_SAFETY_MULTIPLIER = Number(process.env.GAS_SAFETY_MULTIPLIER || 1.25); // require profit > gas*1.25 + minProfit
const FALLBACK_GAS_UNITS = BigInt(Number(process.env.FALLBACK_GAS_UNITS || 300000)); // fallback gas units
const FINAL_FALLBACK_GAS_USDC = Number(process.env.FINAL_FALLBACK_GAS_USDC || 0.01); // last resort

// Routers and tokens (unchanged)
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

const tokens = {
    AAVE: { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
    CRV: { symbol: "CRV", address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
    LINK: { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
    WBTC: { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"; // WMATIC on Polygon

// The exact trade amounts requested by you:
const TRADE_AMOUNTS = [0.02, 0.2, 20, 200, 2000, 20000, 200000];

// CSV logging (unchanged)
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, gasUSDC }) {
    csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, gasUSDC].join(","));
}
function saveCSV() {
    if (csvRows.length === 0) return;
    const header = ["Timestamp", "Token", "BuyRouter", "SellRouter", "AmountUSDC", "ProfitUSDC", "GasUSDC"];
    const filename = `arbitrage_log_${Date.now()}.csv`;
    fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
    console.log(`💾 CSV exported: ${filename}`);
}

// vault & ERC20
let arbContract; // will be instantiated in init()
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

// basic vault ABI (same)
const arbAbi = [
    {
        inputs: [
            { internalType: "address", name: "buyRouter", type: "address" },
            { internalType: "address", name: "sellRouter", type: "address" },
            { internalType: "address", name: "token", type: "address" },
            { internalType: "uint256", name: "amountIn", type: "uint256" },
        ],
        name: "executeArbitrage",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    { inputs: [], name: "USDC", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "minProfit", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
];

async function rotateProvider() {
    // rotate to next RPC in RPC_URLS and recreate provider/wallet/contract instances
    if (RPC_URLS.length <= 1) return;
    RPC_URLS.push(RPC_URLS.shift());
    provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
    wallet = new Wallet(process.env.PRIVATE_KEY || "", provider);
    arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet);
    try {
        const usdcAddr = await arbContract.USDC();
        usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    } catch (e) {
        // ignore, init() will re-run proper set
    }
    console.log("ℹ️ Rotated provider to:", RPC_URLS[0]);
}

async function init() {
    // instantiate contract with wallet signer
    arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet);

    // Defensive checks: ensure executeArbitrage exists
    if (!arbContract || typeof arbContract.executeArbitrage !== "function") {
        console.error("❌ arbContract.executeArbitrage is not a function — aborting. Contract or ABI mismatch.");
        throw new Error("arbContract.executeArbitrage missing");
    }

    // diagnostics for missing estimateGas / callStatic
    console.log("ℹ️ Contract helper namespaces:",
        "hasEstimateGas=", !!arbContract.estimateGas,
        "hasCallStatic=", !!arbContract.callStatic,
        "wallet.addr=", wallet.address
    );

    // ensure USDC address resolved correctly
    const usdcAddr = await arbContract.USDC();
    if (!usdcAddr || usdcAddr === ethers.ZeroAddress) {
        console.error("❌ arbContract.USDC() returned invalid address:", usdcAddr);
        throw new Error("Invalid USDC address from vault");
    }
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);

    const owner = await arbContract.owner();
    console.log(`🏛 Contract Address: ${VAULT_CONTRACT}`);
    console.log(`👤 Contract Owner: ${owner}`);
    console.log(`💱 Vault USDC token: ${usdcAddr}`);
}

function fmt(n, dec = 6) {
    return Number(n).toFixed(dec);
}

// small retry helper
async function retry(fn, attempts = 3, delayMs = 200) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        }
    }
    throw lastErr;
}

// getAmountsOut helper (returns numeric amount in token units, or 0)
async function getAmountOut(routerAddr, path, amountInRaw) {
    const router = new ethers.Contract(
        routerAddr,
        ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
        provider
    );
    try {
        const amounts = await retry(() => router.getAmountsOut(amountInRaw, path), 3, 150);
        if (!amounts || amounts.length < 2) return 0;
        return amounts;
    } catch (e) {
        // propagate as failure for caller to handle
        throw e;
    }
}

// Robust helper to get gas price (works with provider.getGasPrice() or RPC eth_gasPrice)
async function getGasPriceBigInt() {
    try {
        const gp = await provider.getGasPrice();
        if (gp) return BigInt(gp.toString());
    } catch (e) {
        // fall through
    }
    try {
        const hex = await provider.send("eth_gasPrice", []);
        return BigInt(hex.toString());
    } catch (e) {
        console.warn("⚠️ getGasPrice fallback failed:", e?.message || e);
        const fallbackGwei = Number(process.env.FINAL_FALLBACK_GAS_GWEI || 30); // 30 gwei default
        return BigInt(Math.floor(fallbackGwei * 1e9));
    }
}

// Cache WMATIC->USDC for a short TTL to avoid repeated RPC calls when estimating gas
let maticToUSDCCache = { value: null, ts: 0, ttl: 30_000 }; // 30 seconds
async function getMaticToUSDC() {
    const now = Date.now();
    if (maticToUSDCCache.value && now - maticToUSDCCache.ts < maticToUSDCCache.ttl) {
        return maticToUSDCCache.value;
    }
    try {
        const quick = new ethers.Contract(
            routers.QuickSwap,
            ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
            provider
        );
        const oneMatic = ethers.parseUnits("1", 18);
        const usdcAddr = await arbContract.USDC();
        const amounts = await retry(() => quick.getAmountsOut(oneMatic, [WMATIC, usdcAddr]), 3, 150);
        const usdcPerMatic = Number(ethers.formatUnits(amounts[1], 6));
        if (!usdcPerMatic || !isFinite(usdcPerMatic) || usdcPerMatic <= 0) {
            throw new Error("WMATIC->USDC quote invalid");
        }
        maticToUSDCCache = { value: usdcPerMatic, ts: now, ttl: maticToUSDCCache.ttl };
        return usdcPerMatic;
    } catch (e) {
        console.warn("⚠️ getMaticToUSDC failed:", e?.message || e);
        throw e;
    }
}

// Robust Estimate gas cost in USDC
async function estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    // convert amount to raw (USDC decimals = 6)
    const parsed = ethers.parseUnits(amountUSDC.toString(), 6);

    // Helper to convert native MATIC wei BigInt to USDC
    async function nativeWeiToUSDC(weiBigInt) {
        try {
            const usdcPerMatic = await getMaticToUSDC();
            const maticAmount = Number(weiBigInt.toString()) / 1e18;
            return maticAmount * usdcPerMatic;
        } catch (e) {
            throw e;
        }
    }

    // PRIMARY: try estimateGas using populated tx + provider.estimateGas
    try {
        const populated = await arbContract.populateTransaction.executeArbitrage(buyRouter, sellRouter, tokenAddr, parsed);
        const txForEst = {
            to: VAULT_CONTRACT,
            data: populated.data,
            from: wallet.address,
        };
        const gasEstimate = await provider.estimateGas(txForEst);
        const gasUsed = BigInt(gasEstimate.toString());
        const gasPrice = await getGasPriceBigInt();
        const gasCostNativeWei = gasUsed * gasPrice;
        const gasCostUSDC = await nativeWeiToUSDC(gasCostNativeWei);
        if (!isFinite(gasCostUSDC) || gasCostUSDC <= 0) throw new Error("Invalid primary gasCostUSDC");
        return gasCostUSDC;
    } catch (primaryErr) {
        console.warn("⚠️ Gas estimate primary failed (populate/provider.estimateGas):", primaryErr?.message || primaryErr);
        // FALLBACK: conservative units * gasPrice
        try {
            const gasPrice = await getGasPriceBigInt();
            const gasCostNativeWei = FALLBACK_GAS_UNITS * gasPrice;
            const gasCostUSDC = await nativeWeiToUSDC(gasCostNativeWei);
            if (!isFinite(gasCostUSDC) || gasCostUSDC <= 0) throw new Error("Invalid fallback gasCostUSDC");
            console.log(`ℹ️ Fallback gas estimate used: units=${FALLBACK_GAS_UNITS} => ${fmt(gasCostUSDC, 6)} USDC`);
            return gasCostUSDC;
        } catch (fallbackErr) {
            console.warn("⚠️ Gas estimation fallback failed:", fallbackErr?.message || fallbackErr);
            console.warn(`⚠️ FINAL fallback: returning hardcoded ${FINAL_FALLBACK_GAS_USDC} USDC (very conservative).`);
            return FINAL_FALLBACK_GAS_USDC;
        }
    }
}

// Execute trade with protections
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    const timestamp = new Date().toISOString();
    const tokenObj =
        Object.values(tokens).find((t) => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18, symbol: tokenAddr };
    console.log(`\n🔍 ---------- New Trade Attempt ----------`);
    console.log(`🔹 ${timestamp} • Token: ${tokenObj.symbol} • AmountIn: ${amountUSDC} USDC`);

    // Vault balance before
    const beforeBal = await usdcContract.balanceOf(VAULT_CONTRACT);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);
    if (amountUSDC < MIN_TRADE_USDC) {
        console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
        return;
    }

    // GET QUOTES carefully: buy USDC -> token, then token -> USDC back
    const usdcAddr = await arbContract.USDC();
    try {
        // buy: USDC -> token
        const amountInRaw = ethers.parseUnits(amountUSDC.toString(), 6);
        const buyAmounts = await getAmountOut(buyRouter, [usdcAddr, tokenObj.address], amountInRaw); // returns array [in, out]
        const tokenOutRaw = buyAmounts[1]; // raw token units
        if (!tokenOutRaw) {
            console.log("❌ Skipping — failed to get buy quote");
            return;
        }
        // sell: token -> USDC
        const sellAmounts = await getAmountOut(sellRouter, [tokenObj.address, usdcAddr], tokenOutRaw);
        const usdcBackRaw = sellAmounts[1];
        if (!usdcBackRaw) {
            console.log("❌ Skipping — failed to get sell quote");
            return;
        }

        // Convert to numbers
        const tokenOut = Number(ethers.formatUnits(tokenOutRaw, tokenObj.decimals));
        const usdcBack = Number(ethers.formatUnits(usdcBackRaw, 6));

        const expectedProfitUSDC = (usdcBack - amountUSDC) * (1 - SLIPPAGE_PCT / 100);
        // For logs show per-unit prices (USDC per token)
        const buyPrice = amountUSDC / (tokenOut || Number.EPSILON);
        const sellPrice = usdcBack / (tokenOut || Number.EPSILON);
        console.log(`📈 Quoted: buy=${fmt(buyPrice)} sell=${fmt(sellPrice)} expected=${fmt(expectedProfitUSDC)}`);

        if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
            console.log("❌ PREVENTED — profit too low");
            return;
        }

        // Estimate gas cost robustly
        const estGasUSDC = await estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC);
        if (!isFinite(estGasUSDC) || estGasUSDC === Infinity || estGasUSDC <= 0) {
            console.log("❌ PREVENTED — cannot estimate gas cost (safety)");
            return;
        }
        console.log(`⛽ Estimated gas: ${fmt(estGasUSDC, 6)} USDC`);

        if (expectedProfitUSDC <= estGasUSDC + MIN_EXPECTED_PROFIT) {
            console.log(`❌ PREVENTED — expected profit ${fmt(expectedProfitUSDC)} ≤ gas ${fmt(estGasUSDC)} + minProfit ${MIN_EXPECTED_PROFIT}`);
            return;
        }

        if (expectedProfitUSDC <= estGasUSDC * GAS_SAFETY_MULTIPLIER + MIN_EXPECTED_PROFIT) {
            console.log(`❌ PREVENTED — expected profit ${fmt(expectedProfitUSDC)} ≤ gas*${GAS_SAFETY_MULTIPLIER} ${fmt(estGasUSDC * GAS_SAFETY_MULTIPLIER)} + minProfit ${MIN_EXPECTED_PROFIT}`);
            return;
        }

        const profitPct = (expectedProfitUSDC / amountUSDC) * 100;
        if (profitPct < MIN_PROFIT_PCT) {
            console.log(`❌ PREVENTED — profit pct ${fmt(profitPct, 4)}% < MIN_PROFIT_PCT ${MIN_PROFIT_PCT}%`);
            return;
        }

        // Robust on-chain simulation using provider.call + populated tx
        try {
            const parsed = ethers.parseUnits(amountUSDC.toString(), 6);
            const populated = await arbContract.populateTransaction.executeArbitrage(buyRouter, sellRouter, tokenAddr, parsed);
            const callTx = { to: VAULT_CONTRACT, data: populated.data, from: wallet.address };
            await provider.call(callTx);
        } catch (err) {
            console.log("❌ On-chain profitability check failed:", err?.reason || err?.message || err);
            // rotate provider and try once more (common fix for flaky RPC)
            try {
                await rotateProvider();
                const parsed = ethers.parseUnits(amountUSDC.toString(), 6);
                const populated = await arbContract.populateTransaction.executeArbitrage(buyRouter, sellRouter, tokenAddr, parsed);
                const callTx = { to: VAULT_CONTRACT, data: populated.data, from: wallet.address };
                await provider.call(callTx);
            } catch (err2) {
                console.log("❌ On-chain profitability check failed after provider rotate:", err2?.reason || err2?.message || err2);
                return;
            }
        }

        // Execute actual trade with an extra pre-send vault balance check
        console.log("🚀 Executing arbitrage...");
        try {
            // Double-check vault balance right before sending tx
            const preBalNow = await usdcContract.balanceOf(VAULT_CONTRACT);
            const preNow = Number(ethers.formatUnits(preBalNow, 6));
            if (preNow < before - 1e-12) {
                console.log(`❌ PREVENTED — vault balance changed unexpectedly (before ${fmt(before)} -> now ${fmt(preNow)})`);
                return;
            }

            if (DRY_RUN) {
                console.log("🔬 DRY_RUN enabled — would have executed transaction here (skipping send).");
                // Log the simulated successful row
                logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: expectedProfitUSDC, gasUSDC: estGasUSDC });
                return;
            }

            // Send tx
            const tx = await arbContract.executeArbitrage(
                buyRouter,
                sellRouter,
                tokenAddr,
                ethers.parseUnits(amountUSDC.toString(), 6)
            );
            console.log(`🔁 TX SENT — hash: ${tx.hash}`);
            const receipt = await tx.wait();
            if (!receipt || receipt.status === 0) {
                console.log("❌ Transaction reverted");
                return;
            }

            const afterBal = await usdcContract.balanceOf(VAULT_CONTRACT);
            const after = Number(ethers.formatUnits(afterBal, 6));
            console.log(`🏦 Vault Balance After: ${fmt(after)} USDC`);
            const netProfit = after - before;
            console.log(`💰 REAL Net Profit: ${fmt(netProfit)} USDC (gas est ${fmt(estGasUSDC)} USDC)`);

            // If vault decreased despite all checks, raise alert and record for audit
            if (after < before) {
                console.error("🔥 ALERT — Vault balance decreased despite protections! After < Before.");
                logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, gasUSDC: estGasUSDC });
                saveCSV();
                return;
            }

            // Log success
            logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, gasUSDC: estGasUSDC });
            saveCSV();
        } catch (e) {
            console.error("scan error during execution:", e?.message || e);
            // Attempt provider rotation if errors look RPC-related
            await rotateProvider();
        }
    } catch (e) {
        console.log("❌ Skipping — failed to get price or encountered error:", e?.message || e);
        return;
    }
}

// scan over tokens & routers (unchanged except takes custom trade amount)
async function scanOnce(tradeAmountUSDC = 1) {
    for (const token of Object.values(tokens)) {
        for (const buyRouter of Object.values(routers)) {
            for (const sellRouter of Object.values(routers)) {
                if (buyRouter === sellRouter) continue;
                try {
                    await executeTradeLive(buyRouter, sellRouter, token.address, tradeAmountUSDC);
                } catch (e) {
                    console.error("scan error:", e?.message || e);
                }
            }
        }
    }
}

(async function main() {
    await init();
    console.log(`🚀 AUTO-SCAN ENABLED — will sweep trade amounts: ${TRADE_AMOUNTS.join(", ")}`);
    // Sweep through requested trade amounts sequentially (one scan per amount)
    for (const amt of TRADE_AMOUNTS) {
        try {
            console.log(`\n===== SCANNING with TRADE_AMOUNT = ${amt} USDC =====`);
            await scanOnce(amt);
        } catch (e) {
            console.error("sweep error:", e?.message || e);
        }
        // brief pause between amount sweeps to reduce rate pressure
        await new Promise((r) => setTimeout(r, 1000));
    }

    // Continue periodic scanning on the largest (or default) amount every 30s if desired
    const scanIntervalMs = Number(process.env.SCAN_INTERVAL_MS || 30000);
    console.log(`🚀 Entering continuous auto-scan every ${scanIntervalMs / 1000}s using last amount ${TRADE_AMOUNTS[TRADE_AMOUNTS.length - 1]} USDC`);
    setInterval(async () => {
        try {
            await scanOnce(TRADE_AMOUNTS[TRADE_AMOUNTS.length - 1]);
        } catch (e) {
            console.error("loop error", e?.message || e);
            await rotateProvider();
        }
    }, scanIntervalMs);
})();
