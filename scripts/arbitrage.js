```javascript
// improved-arbitrage.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true"; // Changed from true to false
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 20);
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.01);
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.001);

const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.0);
const MAX_PROFIT_PCT = 40;

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const tokens = {
    AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
    CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
    LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
    WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
    csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
    if (csvRows.length === 0) return;
    const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
    const filename = `arbitrage_log_${Date.now()}.csv`;
    fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
    console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------
const arbAbi = [{
    "inputs": [...],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
}, {
    "inputs": [],
    "name": "USDC",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
}, {
    "inputs": [],
    "name": "minProfit",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
}];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
    : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ---------- ERC20 balance checker ----------
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
    try {
        const usdcAddr = await arbContract.USDC();
        usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
        console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    } catch (e) {
        console.warn("⚠️ Initialization warning:", e.message);
    }
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

// getAmountsOut wrapper
async function getAmountOut(routerAddr, token, amountUSDC) {
    const router = new ethers.Contract(
        routerAddr,
        ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
        provider
    );

    const usdcAddress = await arbContract.USDC();
    const path = [usdcAddress, token.address];

    try {
        const amounts = await router.getAmountsOut(
            ethers.parseUnits(amountUSDC.toString(), 6),
            path
        );
        return Number(ethers.formatUnits(amounts[1], token.decimals));
    } catch (err) {
        return 0; // If the router fails, consider it as no arbitrage opportunity
    }
}

// Primary function to execute arbitrage trades
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
    const timestamp = new Date().toISOString();
    const tokenObj = tokens[tokenAddr] || { address: tokenAddr, decimals: 18 };

    try {
        console.log("🔍 ---------- New Trade Attempt ----------");

        const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        const before = Number(ethers.formatUnits(beforeBal, 6));

        if (amountUSDC < MIN_TRADE_USDC) {
            console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
            return;
        }

        const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
        const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);

        if (buyOut <= 0 || sellOut <= 0) {
            console.log("⚠️ No valid arbitrage opportunity found.");
            return;
        }

        const buyPrice = amountUSDC / buyOut;
        const sellPrice = amountUSDC / sellOut;
        let expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
        
        if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
            console.log("❌ PREVENTED — Not enough expected profit");
            return;
        }

        if ((expectedProfitUSDC + before) <= before) {
            console.log("⚠️ Executing trade would not increase balance.");
            return;
        }

        // Attempt the trade only if there's a potential to increase the balance
        if (!DRY_RUN) {
            const tx = await arbContract.executeArbitrage(
                buyRouter, sellRouter, tokenAddr,
                ethers.parseUnits(amountUSDC.toString(), 6)
            );
            const receipt = await tx.wait();
            console.log(`✅ Transaction success — ${receipt.transactionHash}`);
        }

        const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        const after = Number(ethers.formatUnits(afterBal, 6));

        if (after <= before) {
            console.log("⚠️ No net profit — ignored");
            return;
        }

        const netProfit = after - before;
        console.log(`💰 REAL PROFIT: ${fmt(netProfit)}`);
        logTradeCSV({ timestamp, symbol: tokenAddr, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });

    } catch (err) {
        console.error("⚠️ Unexpected trade error:", err.message);
    }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01);

async function scanAllPairs() {
    console.log("\n🔍 Scanning all tokens & routers...");
    for (const [symbol, token] of Object.entries(tokens)) {
        for (const [buyName, buyRouter] of Object.entries(routers)) {
            for (const [sellName, sellRouter] of Object.entries(routers)) {
                if (buyName === sellName) continue;

                try {
                    const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
                    const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

                    const buyPrice = TRADE_AMOUNT_USDC / buyOut;
                    const sellPrice = TRADE_AMOUNT_USDC / sellOut;
                    let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
                    let profitPct = (profitUSDC / buyPrice) * 100;

                    if (profitPct > MAX_PROFIT_PCT) continue;

                    console.log(`${symbol} | ${buyName}→${sellName} | profit=${fmt(profitUSDC)} USDC | profitPct=${fmt(profitPct)}%`);

                    // Limit to only executing trades that are expected to increase the vault balance
                    if (profitPct >= MIN_PROFIT_PCT) {
                        console.log("🚨 PROFITABLE — executing");
                        await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
                    }

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
    console.log("🚀 Improved arbitrage runner started");

    // Continuous 10-second scanning loop
    setInterval(async () => {
        try {
            await scanAllPairs();
        } catch (e) {
            console.error("Fatal scanner error:", e.message);
        }
    }, 10000);
})();
```

  
