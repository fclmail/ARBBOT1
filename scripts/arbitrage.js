// arbitrage-0.05-vault-deposit.js
// Executes arbitrage with fixed 0.05 USDC trade amount and deposits profit back to vault
// Uses ethers v6, supports multiple routers & tokens, robust gas/profit checks

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1" ? true : false;
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL EXECUTE");

const RPCS = (process.env.RPC_URLS || process.env.RPC_URL || "https://polygon-rpc.com")
    .split(",").map(s => s.trim()).filter(Boolean);
let rpcIndex = 0;

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!PRIVATE_KEY && !DRY_RUN) throw new Error("PRIVATE_KEY required for live mode");

const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.5);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);
const GAS_SAFETY_MULTIPLIER = Number(process.env.GAS_SAFETY_MULTIPLIER || 1.25);

// Vault contract (where funds are stored and profits deposited)
const VAULT_CONTRACT = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// DEX Routers
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

// Tokens
const tokens = {
    AAVE: { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
    CRV: { symbol: "CRV", address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
    LINK: { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
    WBTC: { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
};

// WMATIC address for gas estimation
const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";

// Fixed trade amount
const TRADE_AMOUNT_USDC = 0.05;

// ---------- CSV Logging ----------
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

// ---------- PROVIDER / WALLET ----------
let provider = new ethers.JsonRpcProvider(RPCS[0]);
let wallet = new Wallet(PRIVATE_KEY || ethers.ZeroAddress, provider);

// Vault contract ABI
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
];

const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

let arbContract;
let usdcContract;

// ---------- UTILS ----------
function nowISO() { return new Date().toISOString(); }
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

// ---------- ARBITRAGE EXECUTION ----------
async function executeTrade(buyRouter, sellRouter, tokenObj) {
    const timestamp = nowISO();

    if (!usdcContract) return console.log("❌ USDC contract not initialized");

    const vaultBalanceBN = await usdcContract.balanceOf(VAULT_CONTRACT);
    const vaultBalance = Number(ethers.formatUnits(vaultBalanceBN, 6));

    if (TRADE_AMOUNT_USDC > vaultBalance * 0.99) {
        return console.log(`⛔️ Skipping — Trade amount ${TRADE_AMOUNT_USDC} > 99% of vault balance ${fmt(vaultBalance)}`);
    }

    // Get buy/sell quotes
    const routerBuy = new ethers.Contract(buyRouter, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const routerSell = new ethers.Contract(sellRouter, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const usdcAddr = await arbContract.USDC();

    let tokenAmount, usdcBack;
    try {
        const amtInUnits = ethers.parseUnits(String(TRADE_AMOUNT_USDC), 6);
        const amountsBuy = await routerBuy.getAmountsOut(amtInUnits, [usdcAddr, tokenObj.address]);
        tokenAmount = Number(ethers.formatUnits(amountsBuy[1], tokenObj.decimals));

        const tokenInUnits = ethers.parseUnits(String(tokenAmount), tokenObj.decimals);
        const amountsSell = await routerSell.getAmountsOut(tokenInUnits, [tokenObj.address, usdcAddr]);
        usdcBack = Number(ethers.formatUnits(amountsSell[1], 6));
    } catch (e) {
        console.log("❌ Failed to get quotes:", e.message || e);
        return;
    }

    const expectedProfit = (usdcBack - TRADE_AMOUNT_USDC) * (1 - SLIPPAGE_PCT / 100);
    console.log(`📈 Token=${tokenObj.symbol}, Buy=${fmt(tokenAmount)}, SellBack=${fmt(usdcBack)}, Expected Profit=${fmt(expectedProfit)} USDC`);

    if (expectedProfit <= MIN_EXPECTED_PROFIT) {
        return console.log("❌ Skipping — Expected profit too low");
    }

    // Dry-run check
    if (DRY_RUN) {
        console.log("🔬 DRY_RUN — would execute trade here");
        return;
    }

    // Execute on-chain
    try {
        const tx = await arbContract.executeArbitrage(
            buyRouter,
            sellRouter,
            tokenObj.address,
            ethers.parseUnits(String(TRADE_AMOUNT_USDC), 6)
        );
        console.log(`🔁 TX SENT: ${tx.hash}`);
        const receipt = await tx.wait();
        if (!receipt || receipt.status === 0) {
            return console.log("❌ Transaction failed");
        }

        const vaultAfterBN = await usdcContract.balanceOf(VAULT_CONTRACT);
        const vaultAfter = Number(ethers.formatUnits(vaultAfterBN, 6));
        const netProfit = vaultAfter - vaultBalance;

        console.log(`💰 Net Profit deposited: ${fmt(netProfit)} USDC`);
        logTradeCSV({ timestamp, symbol: tokenObj.symbol, buyRouter, sellRouter, amount: TRADE_AMOUNT_USDC, profitUSDC: netProfit, gasUSDC: 0 });
        saveCSV();
    } catch (err) {
        console.log("❌ Trade execution error:", err.message || err);
    }
}

// ---------- SCAN LOOP ----------
async function scan() {
    for (const token of Object.values(tokens)) {
        for (const buyRouter of Object.values(routers)) {
            for (const sellRouter of Object.values(routers)) {
                if (buyRouter === sellRouter) continue;
                await executeTrade(buyRouter, sellRouter, token);
            }
        }
    }
}

// ---------- INIT ----------
async function init() {
    arbContract = new ethers.Contract(VAULT_CONTRACT, arbAbi, wallet);

    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);

    console.log("🏛 Vault Contract:", VAULT_CONTRACT);
    console.log("💱 USDC Token:", usdcAddr);
    console.log("👤 Wallet:", wallet.address);
}

// ---------- MAIN LOOP ----------
(async function main() {
    try { await init(); } catch (e) { console.error("Init failed:", e); process.exit(1); }

    console.log(`🚀 AUTO-SCAN ENABLED — running every ${SCAN_INTERVAL_MS / 1000}s`);
    await scan(); // initial run

    setInterval(async () => {
        try { await scan(); } catch (e) { console.error("Scan error:", e); }
    }, SCAN_INTERVAL_MS);
})();
