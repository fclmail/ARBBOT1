// ---------------------------------------------------------
// ARBITRAGE BOT – FULL VERSION WITH DECIMAL FIXES
// - BigNumber-safe trade amounts
// - Correct profit calculation
// - All previous features intact (vault guard, simulation, CSV)
// ---------------------------------------------------------

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "false";
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.05); // % profit threshold
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 12); 
const MIN_TRADE_USDC = 0.01;
const GAS_EST_USDC = 0.002;
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);
const MAX_PROFIT_PCT = 40;
const VAULT_GUARD_DROP_PCT = 20;

// Routers
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens
const tokens = {
    AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
    CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
    LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
    WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, profitPct }) {
    csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC, profitPct].join(","));
}
function saveCSV() {
    if (csvRows.length === 0) return;
    const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","ProfitPct"];
    const filename = `arbitrage_log_${Date.now()}.csv`;
    fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
    console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------
const arbAbi = [
    { "inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],"name":"executeArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function"},
    { "inputs":[],"name":"USDC","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    { "inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    { "inputs":[],"name":"minProfit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

const arbContract = DRY_RUN ? 
    new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider) : 
    new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ERC20 helper
let usdcContract;
let usdcDecimals = 6; // default USDC decimals
const erc20Abi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

async function init() {
    try {
        const usdcAddr = await arbContract.USDC();
        usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
        usdcDecimals = await usdcContract.decimals();
        const owner = await arbContract.owner();
        console.log("🏛 Vault Address:", CONTRACT_ADDRESS);
        console.log("💵 USDC Address :", usdcAddr);
        console.log("👤 Contract Owner:", owner);
        console.log("🔹 USDC Decimals:", usdcDecimals);
    } catch (e) {
        console.warn("⚠️ Initialization warning:", e.message);
    }
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountUSDC) {
    const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const usdcAddress = await arbContract.USDC();
    const path = [usdcAddress, token.address];

    try {
        const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), usdcDecimals), path);
        return ethers.formatUnits(amounts[1], token.decimals);
    } catch (err) {
        // fallback via WBTC
        const fallback = [usdcAddress, tokens.WBTC.address, token.address];
        const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), usdcDecimals), fallback);
        return ethers.formatUnits(amounts[2], token.decimals);
    }
}

async function priceSanityCheck(routerAddr, token, amountUSDC) {
    try {
        const out = await getAmountOut(routerAddr, token, amountUSDC);
        return Number(out) > 0 && Number.isFinite(out);
    } catch { return false; }
}

// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;
let vaultGuardActive = true;
let initialVaultBalance = null;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    const timestamp = new Date().toISOString();
    const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) || { address: tokenAddr, decimals: 18 };

    try {
        const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        const before = Number(ethers.formatUnits(beforeBal, usdcDecimals));
        if (!initialVaultBalance) initialVaultBalance = before;

        // Vault guard
        if (vaultGuardActive && before < (initialVaultBalance * (1 - VAULT_GUARD_DROP_PCT/100))) {
            vaultGuardActive = false;
            console.log("⚠️ Vault balance dropped >20%. Trades disabled until restart.");
            return;
        }

        console.log("\n🔍 ---------- New Trade Attempt ----------");
        console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);
        console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

        if (!vaultGuardActive) return;
        if (amountUSDC < MIN_TRADE_USDC) return;

        // ---------- Compute Expected Profit ----------
        const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
        const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);

        const buyAmountBN = ethers.parseUnits(amountUSDC.toString(), usdcDecimals);
        const buyOutBN = ethers.parseUnits(buyOut.toString(), tokenObj.decimals);
        const sellOutBN = ethers.parseUnits(sellOut.toString(), tokenObj.decimals);

        const buyPrice = buyAmountBN.mul(ethers.parseUnits("1", tokenObj.decimals)).div(buyOutBN);
        const sellPrice = buyAmountBN.mul(ethers.parseUnits("1", tokenObj.decimals)).div(sellOutBN);

        const expectedProfitUSDCBN = sellPrice.sub(buyPrice).mul(ethers.parseUnits("1", usdcDecimals)).div(ethers.parseUnits("1", tokenObj.decimals));
        const expectedProfitPct = Number(ethers.formatUnits(expectedProfitUSDCBN, usdcDecimals)) / amountUSDC * 100;

        console.log(`🔹 BuyOut: ${fmt(buyOut, tokenObj.decimals)} | SellOut: ${fmt(sellOut, tokenObj.decimals)}`);
        console.log(`🔹 Expected Profit: ${fmt(ethers.formatUnits(expectedProfitUSDCBN, usdcDecimals))} USDC`);
        console.log(`🔹 Expected Profit %: ${fmt(expectedProfitPct)}%`);

        if (expectedProfitPct < MIN_PROFIT_PCT || expectedProfitPct > MAX_PROFIT_PCT) {
            console.log("⛔ Skipped — profit threshold");
            return;
        }

        if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) || !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) return;

        // ---------- Simulation ----------
        try {
            await provider.call({
                to: CONTRACT_ADDRESS,
                data: arbContract.interface.encodeFunctionData("executeArbitrage", [
                    buyRouter, sellRouter, tokenAddr, buyAmountBN
                ]),
                from: wallet ? wallet.address : undefined
            });
            console.log("🔬 Simulation OK");
        } catch {
            console.log("❌ Simulation failed");
            return;
        }

        if (DRY_RUN) {
            console.log("🧪 DRY RUN — not sending tx");
            return;
        }

        // ---------- Execute Trade ----------
        const gasPrice = await provider.getGasPrice();
        const tx = await arbContract.executeArbitrage(
            buyRouter, sellRouter, tokenAddr, buyAmountBN,
            { gasPrice: gasPrice.mul(120).div(100) }
        );

        console.log(`🔁 TX SENT — ${tx.hash}`);
        const receipt = await tx.wait();
        if (!receipt || receipt.status === 0) {
            console.log("❌ TX failed");
            return;
        }

        const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        const after = Number(ethers.formatUnits(afterBal, usdcDecimals));
        const netProfit = after - before;
        const netProfitPct = (netProfit / before) * 100;

        console.log(`\x1b[32m✅ Transaction success — ${receipt.transactionHash}\x1b[0m`);
        console.log(`🏦 Vault After: ${fmt(after)} USDC`);
        console.log(`💰 REAL PROFIT: ${fmt(netProfit)} USDC`);
        console.log(`📊 Net Profit %: ${fmt(netProfitPct)}%`);

        cumulativeProfit += netProfit;

        const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
        const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
        logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit, profitPct: netProfitPct });

        // Small throttle
        await new Promise(r => setTimeout(r, 300));
    } catch (err) {
        console.error("⚠️ Unexpected trade error:", err.message);
    }
}

// ---------- SCAN LOOP ----------
async function scanAllPairs() {
    console.log("\n🔍 Scanning all tokens & routers...");
    for (const [symbol, token] of Object.entries(tokens)) {
        for (const [buyName, buyRouter] of Object.entries(routers)) {
            for (const [sellName, sellRouter] of Object.entries(routers)) {
                if (buyName === sellName) continue;
                try {
                    await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
                } catch (e) {
                    console.warn(`${symbol} | ${buyName}→${sellName} | scan error:`, e.message);
                }
            }
        }
    }
    saveCSV();
}

// ---------- MAIN ----------
(async function main() {
    await init();
    console.log("🚀 Arbitrage runner started");
    setInterval(async () => {
        try { await scanAllPairs(); } catch (e) { console.error("Fatal scanner error:", e.message); }
    }, 10000);
})();
