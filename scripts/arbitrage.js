// arbitrage-hardcoded-vault-live-protected-fixed-final-multi.js
// Drop-in replacement for ARBBOT1 runner — patched for robust estimate/call and multiple trade amounts.
// Uses Ethers v6. Keep your .env for overrides (RPC_URLS, RPC_URL, PRIVATE_KEY, DRY_RUN, etc)

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1" ? true : false;
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL EXECUTE");

// RPCs: either single RPC_URL or comma-separated RPC_URLS
const RPCS = (process.env.RPC_URLS || process.env.RPC_URL || "https://polygon-rpc.com").split(",").map(s => s.trim()).filter(Boolean);
let rpcIndex = 0;

// env-provided private key
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!PRIVATE_KEY && !DRY_RUN) throw new Error("PRIVATE_KEY required for live mode");

// Safety & economic parameters (defaults kept but override via env)
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.0005); // percent
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.005);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.5);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);
const GAS_SAFETY_MULTIPLIER = Number(process.env.GAS_SAFETY_MULTIPLIER || 1.25);

// HARDCODED VAULT (user-provided)
const VAULT_CONTRACT = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// routers & tokens unchanged (you can extend)
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

// Multi-trade amounts requested by user (USDC). We'll iterate these amounts for each token/router pair.
// NOTE: These are dollars (USDC decimals = 6). Very large values will require vault liquidity; the script will check vault balance before sending.
const TRADE_AMOUNTS_TO_TRY = [0.02, 0.2, 20, 200, 2000, 20000, 200000];

// CSV logging
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

// provider and wallet (created in init / can rotate)
let provider = new ethers.JsonRpcProvider(RPCS[0]);
let wallet = new Wallet(PRIVATE_KEY || ethers.ZeroAddress, provider);

// vault ABI (kept inline)
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
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

let arbContract;
let usdcContract;

// caching WMATIC->USDC conversion for gas price convert
let cachedMaticToUSDC = { value: null, ts: 0 };
const MATIC_CACHE_TTL_MS = 30_000;

// ---------- UTIL HELPERS ----------
function fmt(n, dec = 6) {
    if (typeof n !== "number") return String(n);
    return Number(n).toFixed(dec);
}
function nowISO() { return new Date().toISOString(); }

// retry helper
async function retry(fn, attempts = 3, delayMs = 200) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); } catch (e) { lastErr = e; }
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
    throw lastErr || new Error("retry failed");
}

// rotate to next RPC provider (when encountering persistent provider errors)
async function rotateProvider() {
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    const newRpc = RPCS[rpcIndex];
    console.warn(`🔄 Rotating RPC provider to: ${newRpc}`);
    provider = new ethers.JsonRpcProvider(newRpc);
    wallet = new Wallet(PRIVATE_KEY || ethers.ZeroAddress, provider);
    arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet);
    // usdcContract needs resolved usdc addr; guard with try/catch
    try {
        const usdcAddr = await arbContract.USDC();
        usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    } catch (e) {
        usdcContract = null;
    }
}

// getGasPrice BigInt robust
async function getGasPriceBigInt() {
    try {
        const gp = await provider.getGasPrice();
        if (gp) return BigInt(gp.toString());
    } catch (e) { /* fallback */ }
    try {
        const hex = await provider.send("eth_gasPrice", []);
        return BigInt(hex.toString());
    } catch (e) {
        const fallbackGwei = Number(process.env.FINAL_FALLBACK_GAS_GWEI || 30);
        return BigInt(Math.floor(fallbackGwei * 1e9));
    }
}

// get WMATIC->USDC price (cached)
async function getMaticToUSDC() {
    const now = Date.now();
    if (cachedMaticToUSDC.value && (now - cachedMaticToUSDC.ts < MATIC_CACHE_TTL_MS)) return cachedMaticToUSDC.value;
    try {
        const quick = new ethers.Contract(routers.QuickSwap, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
        const oneMatic = ethers.parseUnits("1", 18);
        const usdcAddr = await arbContract.USDC();
        const amounts = await retry(() => quick.getAmountsOut(oneMatic, [WMATIC, usdcAddr]));
        const usdcPerMatic = Number(ethers.formatUnits(amounts[1], 6));
        if (!usdcPerMatic || !isFinite(usdcPerMatic) || usdcPerMatic <= 0) throw new Error("WMATIC->USDC quote invalid");
        cachedMaticToUSDC = { value: usdcPerMatic, ts: Date.now() };
        return usdcPerMatic;
    } catch (e) {
        throw e;
    }
}

// convert native wei BigInt to USDC number using WMATIC->USDC quote
async function nativeWeiToUSDC(weiBigInt) {
    try {
        const usdcPerMatic = await getMaticToUSDC();
        const maticAmount = Number(weiBigInt.toString()) / 1e18;
        return maticAmount * usdcPerMatic;
    } catch (e) {
        throw e;
    }
}

// Robust gas cost estimation in USDC
async function estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    // PRIMARY: populate tx and provider.estimateGas
    try {
        const parsed = ethers.parseUnits(amountUSDC.toString(), 6);
        const populated = await arbContract.populateTransaction.executeArbitrage(buyRouter, sellRouter, tokenAddr, parsed);
        const txForEst = {
            to: VAULT_CONTRACT,
            data: populated.data,
            from: wallet.address
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
        // fallback conservative approach
        try {
            const defaultGasUnits = BigInt(Number(process.env.FALLBACK_GAS_UNITS || 300000));
            const gasPrice = await getGasPriceBigInt();
            const gasCostNativeWei = defaultGasUnits * gasPrice;
            const gasCostUSDC = await nativeWeiToUSDC(gasCostNativeWei);
            if (!isFinite(gasCostUSDC) || gasCostUSDC <= 0) throw new Error("Invalid fallback gasCostUSDC");
            console.log(`ℹ️ Fallback gas estimate used: units=${defaultGasUnits} => ${fmt(gasCostUSDC, 6)} USDC`);
            return gasCostUSDC;
        } catch (fallbackErr) {
            console.warn("⚠️ Gas estimation fallback failed:", fallbackErr?.message || fallbackErr);
            const hardcoded = Number(process.env.FINAL_FALLBACK_GAS_USDC || 0.01);
            console.warn(`⚠️ FINAL fallback: returning hardcoded ${hardcoded} USDC.`);
            return hardcoded;
        }
    }
}

// QUOTING HELPERS
// get token amount you receive when swapping amountUSDC (USDC decimals=6) on router (USDC -> token)
async function getTokenAmountForUSDC(routerAddr, tokenObj, amountUSDC) {
    try {
        const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
        const usdcAddr = await arbContract.USDC();
        const inUnits = ethers.parseUnits(amountUSDC.toString(), 6);
        const amounts = await retry(() => router.getAmountsOut(inUnits, [usdcAddr, tokenObj.address]));
        const tokenAmount = amounts[1]; // BigNumber token units
        // convert to normalized number (token units)
        const tokenAmountNum = Number(ethers.formatUnits(tokenAmount, tokenObj.decimals));
        return tokenAmountNum;
    } catch (e) {
        throw e;
    }
}

// get USDC amount you'd receive by swapping `tokenAmount` (number in token units) on router (token -> USDC)
async function getUSDCForTokenAmount(routerAddr, tokenObj, tokenAmount) {
    try {
        const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
        const usdcAddr = await arbContract.USDC();
        const tokenInUnits = ethers.parseUnits(String(tokenAmount), tokenObj.decimals);
        const amounts = await retry(() => router.getAmountsOut(tokenInUnits, [tokenObj.address, usdcAddr]));
        const usdcBack = Number(ethers.formatUnits(amounts[1], 6));
        return usdcBack;
    } catch (e) {
        throw e;
    }
}

// Execute trade with protections
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    const timestamp = nowISO();
    const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18, symbol: tokenAddr };
    console.log(`\n🔍 ---------- New Trade Attempt ----------`);
    console.log(`🔹 ${timestamp} • Token: ${tokenObj.symbol} • AmountIn: ${amountUSDC} USDC`);

    // Vault balance before
    if (!usdcContract) {
        console.log("❌ usdcContract not initialized — skipping");
        return;
    }
    const beforeBal = await usdcContract.balanceOf(VAULT_CONTRACT);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    if (amountUSDC < MIN_TRADE_USDC) {
        console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
        return;
    }

    // ensure not attempting trades far > vault balance (safety)
    if (amountUSDC > before * 0.99) {
        console.log(`⛔️ Skipping — Amount ${amountUSDC} > 99% of vault balance ${fmt(before)}`);
        return;
    }

    // Get quotes (buy USDC->token then token->USDC)
    let tokenAmount, usdcBack;
    try {
        tokenAmount = await getTokenAmountForUSDC(buyRouter, tokenObj, amountUSDC);
    } catch (e) {
        console.log("❌ Skipping — failed to get buy price:", e?.message || e);
        return;
    }

    try {
        usdcBack = await getUSDCForTokenAmount(sellRouter, tokenObj, tokenAmount);
    } catch (e) {
        console.log("❌ Skipping — failed to get sell price:", e?.message || e);
        return;
    }

    const expectedProfitUSDC = (usdcBack - amountUSDC) * (1 - SLIPPAGE_PCT / 100);
    console.log(`📈 Quoted: buyToken=${fmt(tokenAmount, 6)} token ; sellBack=${fmt(usdcBack, 6)} USDC => expected=${fmt(expectedProfitUSDC, 6)} USDC`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
        console.log("❌ PREVENTED — profit too low");
        return;
    }

    // Estimate gas cost robustly
    let estGasUSDC;
    try {
        estGasUSDC = await estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC);
    } catch (e) {
        console.log("❌ PREVENTED — cannot estimate gas cost (safety):", e?.message || e);
        return;
    }
    if (!isFinite(estGasUSDC) || estGasUSDC <= 0) {
        console.log("❌ PREVENTED — cannot estimate gas cost (safety)");
        return;
    }
    console.log(`⛽ Estimated gas: ${fmt(estGasUSDC, 6)} USDC`);

    // economic checks
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

    // Call simulation using provider.call with populated tx
    try {
        const parsed = ethers.parseUnits(amountUSDC.toString(), 6);
        const populated = await arbContract.populateTransaction.executeArbitrage(buyRouter, sellRouter, tokenAddr, parsed);
        const callTx = { to: VAULT_CONTRACT, data: populated.data, from: wallet.address };
        await provider.call(callTx);
    } catch (err) {
        console.log("❌ On-chain profitability check failed:", err?.reason || err?.message || err);
        return;
    }

    // Execute actual trade with pre-send vault balance check
    console.log("🚀 Executing arbitrage (live)...");
    try {
        const preBalNow = await usdcContract.balanceOf(VAULT_CONTRACT);
        const preNow = Number(ethers.formatUnits(preBalNow, 6));
        if (preNow < before - 1e-12) {
            console.log(`❌ PREVENTED — vault balance changed unexpectedly (before ${fmt(before)} -> now ${fmt(preNow)})`);
            return;
        }

        if (DRY_RUN) {
            console.log("🔬 DRY_RUN enabled — would have executed transaction here (skipping send).");
            return;
        }

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

        if (after < before) {
            console.error("🔥 ALERT — Vault balance decreased despite protections! After < Before.");
            logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, gasUSDC: estGasUSDC });
            saveCSV();
            return;
        }

        logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, gasUSDC: estGasUSDC });
        saveCSV();
    } catch (e) {
        console.error("scan error:", e?.message || e);
        // if provider errors look persistent, rotate RPC and continue
        if (e && String(e).toLowerCase().includes("timeout")) {
            try { await rotateProvider(); } catch (rotE) { console.warn("rotateProvider failed:", rotE?.message || rotE); }
        }
    }
}

// scan over tokens & routers, but iterate multiple trade amounts
async function scanOnce(tradeAmounts = TRADE_AMOUNTS_TO_TRY) {
    for (const token of Object.values(tokens)) {
        for (const buyRouter of Object.values(routers)) {
            for (const sellRouter of Object.values(routers)) {
                if (buyRouter === sellRouter) continue;
                for (const amt of tradeAmounts) {
                    try {
                        await executeTradeLive(buyRouter, sellRouter, token.address, amt);
                    } catch (e) {
                        console.error("scan error:", e?.message || e);
                    }
                }
            }
        }
    }
}

// init and run
async function init() {
    // provider & wallet already created above; ensure arbContract is instantiated
    arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet);

    // Diagnostics: presence of estimateGas/callStatic
    console.log("ℹ️ Contract helper namespaces:",
        "hasEstimateGas=", !!arbContract.estimateGas,
        "hasCallStatic=", !!arbContract.callStatic,
        "wallet.addr=", wallet.address
    );

    // ensure executeArbitrage exists (defensive)
    if (!arbContract || typeof arbContract.executeArbitrage !== "function") {
        console.error("❌ arbContract.executeArbitrage is not a function — aborting. Contract or ABI mismatch.");
        throw new Error("arbContract.executeArbitrage missing");
    }

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

(async function main() {
    try {
        await init();
    } catch (e) {
        console.error("init failed:", e?.message || e);
        process.exit(1);
    }

    console.log(`🚀 AUTO-SCAN ENABLED — scanning every ${SCAN_INTERVAL_MS / 1000} seconds`);
    // Start an initial scan (tries all trade amounts)
    await scanOnce(TRADE_AMOUNTS_TO_TRY);

    // Continue periodic scanning
    setInterval(async () => {
        try {
            await scanOnce(TRADE_AMOUNTS_TO_TRY);
        } catch (e) {
            console.error("loop error", e?.message || e);
        }
    }, SCAN_INTERVAL_MS);
})();
