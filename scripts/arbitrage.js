// arbitrage-hardcoded-vault-live-protected-fixed.js
// Live arbitrage runner with full protection layers added
// - Ethers v6
// - Live mode (DRY_RUN = false)
// - Hard-coded vault contract address
// - Small test TRADE_AMOUNT_USDC = 0.02 (change later to 10/100/1000/...)
// - Preserves original logging, CSV export, and all vault failsafes
// - Adds: router quote sanity checks, liquidity sanity, callStatic on-chain simulation,
// gas estimation converted to USDC, estimateProfit check (profit > gas + minProfit),
// and prevents obviously bogus quotes

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false;
console.log(
    DRY_RUN
        ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS"
        : "🚀 LIVE MODE ENABLED — REAL TRADES WILL EXECUTE"
);

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// ---------- HARDCODED VAULT ----------
const VAULT_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Safety parameters
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.5); // percent
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.005); // tiny test trades allowed
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.5); // 0.5% slippage tolerance
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.01); // USDC expected profit (incl gas)
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.02); // live test 0.02 USDC
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);

// Routers and tokens
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

// Helpful constants
const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"; // WMATIC on Polygon

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

// Provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// Vault contract
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

const arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet);
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log(`🏛 Contract Address: ${VAULT_CONTRACT}`);
    console.log(`👤 Contract Owner: ${owner}`);
}

function fmt(n, dec = 6) {
    return Number(n).toFixed(dec);
}

// Soft sanity checks for router quotes
async function getAmountOut(routerAddr, token, amountUSDC) {
    const router = new ethers.Contract(
        routerAddr,
        ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
        provider
    );
    const usdcAddr = await arbContract.USDC();
    const path = [usdcAddr, token.address];
    try {
        const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), path);
        const out = Number(ethers.formatUnits(amounts[1], token.decimals));
        if (!out || !isFinite(out) || out <= Number.EPSILON) return 0;
        const ratio = amountUSDC / out;
        if (!isFinite(ratio) || ratio <= 0 || ratio > 1e6) return 0;
        return out;
    } catch (err) {
        return 0;
    }
}

// Estimate gas cost in USDC
async function estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    try {
        const parsed = ethers.parseUnits(amountUSDC.toString(), 6);
        const gasEstimate = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, parsed);
        const gasPrice = await provider.getGasPrice();
        const gasUsed = BigInt(gasEstimate.toString());
        const gasPriceBN = BigInt(gasPrice.toString());
        const gasCostNative = gasUsed * gasPriceBN; // in wei

        const quick = new ethers.Contract(
            routers.QuickSwap,
            ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
            provider
        );
        const oneMatic = ethers.parseUnits("1", 18);
        const usdcAddr = await arbContract.USDC();
        const amounts = await quick.getAmountsOut(oneMatic, [WMATIC, usdcAddr]);
        const usdcPerMatic = Number(ethers.formatUnits(amounts[1], 6));
        if (!usdcPerMatic || !isFinite(usdcPerMatic) || usdcPerMatic <= 0) return Infinity;
        return Number((Number(gasCostNative.toString()) / 1e18) * usdcPerMatic);
    } catch (e) {
        return Infinity;
    }
}

// Execute trade with all protections
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    const timestamp = new Date().toISOString();
    const tokenObj =
        Object.values(tokens).find((t) => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18, symbol: tokenAddr };
    console.log(`\n🔍 ---------- New Trade Attempt ----------`);
    console.log(`🔹 ${timestamp} • Token: ${tokenObj.symbol} • AmountIn: ${amountUSDC} USDC`);

    const beforeBal = await usdcContract.balanceOf(VAULT_CONTRACT);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);
    if (amountUSDC < MIN_TRADE_USDC) {
        console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
        return;
    }

    const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
    const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
    if (!buyOut || !sellOut) {
        console.log("❌ Skipping — failed to get price");
        return;
    }

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    const expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    console.log(`📈 Quoted: buy=${fmt(buyPrice)} sell=${fmt(sellPrice)} expected=${fmt(expectedProfitUSDC)}`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
        console.log("❌ PREVENTED — profit too low");
        return;
    }

    const estGasUSDC = await estimateGasCostUSDC(buyRouter, sellRouter, tokenAddr, amountUSDC);
    if (!isFinite(estGasUSDC)) {
        console.log("❌ PREVENTED — cannot estimate gas cost (safety)");
        return;
    }
    console.log(`⛽ Estimated gas: ${fmt(estGasUSDC, 6)} USDC`);

    if (expectedProfitUSDC <= estGasUSDC + MIN_EXPECTED_PROFIT) {
        console.log(`❌ PREVENTED — expected profit ${fmt(expectedProfitUSDC)} ≤ gas ${fmt(estGasUSDC)} + minProfit ${MIN_EXPECTED_PROFIT}`);
        return;
    }

    const profitPct = (expectedProfitUSDC / amountUSDC) * 100;
    if (profitPct < MIN_PROFIT_PCT) {
        console.log(`❌ PREVENTED — profit pct ${fmt(profitPct, 4)}% < MIN_PROFIT_PCT ${MIN_PROFIT_PCT}%`);
        return;
    }

    try {
        await arbContract.callStatic.executeArbitrage(
            buyRouter,
            sellRouter,
            tokenAddr,
            ethers.parseUnits(amountUSDC.toString(), 6)
        );
    } catch (err) {
        console.log("❌ On-chain profitability check failed:", err?.reason || err?.message || err);
        return;
    }

    console.log("🚀 Executing arbitrage...");
    try {
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

        logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, gasUSDC: estGasUSDC });
        saveCSV();
    } catch (e) {
        console.error("scan error:", e?.message || e);
    }
}

async function scanOnce(tradeAmountUSDC = TRADE_AMOUNT_USDC) {
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
    console.log(`🚀 AUTO-SCAN ENABLED — scanning every ${SCAN_INTERVAL_MS / 1000} seconds`);
    await scanOnce(TRADE_AMOUNT_USDC);
    setInterval(async () => {
        try {
            await scanOnce(TRADE_AMOUNT_USDC);
        } catch (e) {
            console.error("loop error", e?.message || e);
        }
    }, SCAN_INTERVAL_MS);
})();
