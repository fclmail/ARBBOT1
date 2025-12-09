// =============================================================
// ARB-8 — SAFE ARBITRAGE ENGINE WITH FULL DIAGNOSTIC LOGGING
// =============================================================
// DRY RUN: node arb8.js --dry
// LIVE RUN: node arb8.js --live
// =============================================================

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// -------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------
const CLI_ARGS = process.argv.slice(2);
const LIVE = CLI_ARGS.includes("--live") || CLI_ARGS.includes("-l");
const DRY = !LIVE;

const provider = new ethers.JsonRpcProvider(process.env.RPC);

// Wallet (your private key must belong to you)
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

// Contract ABI
const ABI = JSON.parse(fs.readFileSync("./vault_abi.json", "utf8"));

// Vault contract
const vault = new ethers.Contract(
    process.env.VAULT_ADDRESS,
    ABI,
    wallet
);

// Routers (example)
const ROUTERS = {
    quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
};

const routerABI = JSON.parse(fs.readFileSync("./router_abi.json", "utf8"));

const routerContracts = {
    quickswap: new ethers.Contract(ROUTERS.quickswap, routerABI, provider),
    sushiswap: new ethers.Contract(ROUTERS.sushiswap, routerABI, provider),
};

// Target pair
const TOKEN_IN = process.env.TOKEN_IN;
const TOKEN_OUT = process.env.TOKEN_OUT;

const amount = ethers.parseUnits(process.env.AMOUNT, process.env.DECIMALS);

console.log("\n====================================================");
console.log("   ARB-8 ENGINE INITIALIZED");
console.log("====================================================");
console.log("Mode:", LIVE ? "🚀 LIVE" : "🧪 DRY");
console.log("Wallet:", wallet.address);
console.log("Vault :", process.env.VAULT_ADDRESS);
console.log("====================================================\n");


// -------------------------------------------------------------
// LOGGING HELPERS
// -------------------------------------------------------------
const block = (title) => {
    console.log(`\n========== ${title.toUpperCase()} ==========\n`);
};

const detail = (label, value) => {
    console.log(`🔹 ${label}:`, value);
};


// -------------------------------------------------------------
// GET QUOTES FROM ALL ROUTERS
// -------------------------------------------------------------
async function getQuote(routerName, router, amountIn) {
    block(`QUOTE — ${routerName}`);

    try {
        const path = [TOKEN_IN, TOKEN_OUT];
        detail("Path", path);

        const quote = await router.getAmountsOut(amountIn, path);

        const output = quote[quote.length - 1];

        detail("Raw quote", quote);
        detail("AmountOut", output.toString());

        return output;
    } catch (e) {
        detail("ERROR", e.message);
        return 0n;
    }
}


// -------------------------------------------------------------
// SCAN ARBITRAGE OPPORTUNITIES
// -------------------------------------------------------------
async function scan() {
    block("SCAN START");

    const quotes = {};

    for (const [name, router] of Object.entries(routerContracts)) {
        quotes[name] = await getQuote(name, router, amount);
    }

    console.log("\nCollected Quotes:");
    console.table(
        Object.entries(quotes).map(([k, v]) => ({
            Router: k,
            AmountOut: v.toString(),
        }))
    );

    // Find highest
    const best = Object.entries(quotes).sort((a, b) => Number(b[1] - a[1]))[0];

    block("BEST ROUTER");

    detail("Router", best[0]);
    detail("AmountOut", best[1].toString());

    return {
        bestRouter: best[0],
        bestAmount: best[1],
        allQuotes: quotes,
    };
}


// -------------------------------------------------------------
// PROFITABILITY CHECK
// -------------------------------------------------------------
function checkProfit(bestAmount) {
    block("PROFIT CALCULATION");

    const input = Number(ethers.formatUnits(amount, process.env.DECIMALS));
    const output = Number(ethers.formatUnits(bestAmount, process.env.DECIMALS));

    detail("Input Amount", input);
    detail("Output Amount", output);

    const profit = output - input;

    detail("Raw Profit", profit);

    return profit > 0 ? profit : 0;
}


// -------------------------------------------------------------
// EXECUTE TRADE (LIVE OR DRY)
// -------------------------------------------------------------
async function execute(bestRouter, bestAmount) {
    block("TRADE EXECUTION");

    const routerAddr = ROUTERS[bestRouter];
    detail("Router", bestRouter);
    detail("Router Address", routerAddr);

    // Build basic swap calldata
    const iface = new ethers.Interface(routerABI);
    const calldata = iface.encodeFunctionData("swapExactTokensForTokens", [
        amount,
        bestAmount * 98n / 100n, // 2% slippage
        [TOKEN_IN, TOKEN_OUT],
        wallet.address,
        Math.floor(Date.now() / 1000) + 60
    ]);

    detail("Calldata", calldata);

    const tx = {
        to: routerAddr,
        data: calldata,
        gasLimit: 4000000,
    };

    if (DRY) {
        console.log("\n🧪 DRY MODE — NO TX SENT");
        detail("Prepared TX", tx);
        return;
    }

    console.log("\n🚀 LIVE MODE — SENDING TX");

    const sentTx = await wallet.sendTransaction(tx);
    detail("TX Hash", sentTx.hash);

    const receipt = await sentTx.wait();
    detail("Receipt", receipt);

    console.log("\n✅ TRADE EXECUTED");
}


// -------------------------------------------------------------
// MAIN LOOP
// -------------------------------------------------------------
async function main() {
    console.log("Starting ARB-8 engine…");

    const scanResult = await scan();

    const profit = checkProfit(scanResult.bestAmount);

    if (profit <= 0) {
        console.log("\n❌ No profitable trade detected.");
        return;
    }

    console.log(`\n✅ Profit Detected: ${profit} tokens`);

    await execute(scanResult.bestRouter, scanResult.bestAmount);

    console.log("\n====================================================");
    console.log(" ARB-8 CYCLE COMPLETE");
    console.log("====================================================\n");
}

main();
