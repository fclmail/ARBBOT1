// ---------------------------------------------------------
//  ARBITRAGE BOT – FULL RESTORED VERSION
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

// ---------------------------------------------------------
// ENVIRONMENT VARIABLES (GitHub Secrets Compatible)
// ---------------------------------------------------------

// PRIVATE KEY – MUST BE SET IN GITHUB SECRETS
const WALLET_PRIVATE_KEY =
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    null;

if (!WALLET_PRIVATE_KEY) {
    throw new Error("❌ WALLET_PRIVATE_KEY not found. Add it in GitHub Secrets.");
}

// RPC URL – YOUR SECRET SHOULD ALREADY BE SET
const RPC =
    process.env.RPC_POLYGON ||
    "https://polygon-rpc.com"; // fallback so script never crashes

// ---------------------------------------------------------
// PROVIDER & WALLET
// ---------------------------------------------------------

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ---------------------------------------------------------
// TOKENS (RESTORED)
// ---------------------------------------------------------

const TOKENS = {
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT: "0xC2132D05D31c914a87C6611C10748AEb04B58e8F",
    WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

// ---------------------------------------------------------
// DEX ROUTERS (RESTORED)
// ---------------------------------------------------------

const ROUTERS = {
    quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    uniswapv3: "0x1F98431c8aD98523631AE4a59f267346ea31F984"
};

// ---------------------------------------------------------
// FORMAT HELPERS
// ---------------------------------------------------------

const fmt = (v) => Number(ethers.formatUnits(v, 6)).toFixed(6);

// ---------------------------------------------------------
// SIMULATE ARBITRAGE & TRACK PROFITS
// ---------------------------------------------------------

let vaultBalance = 0; // Local simulated vault state
let totalProfit = 0;

async function getPrice(router, tokenIn, tokenOut, amountIn) {
    try {
        const contract = new ethers.Contract(
            router,
            ["function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)"],
            provider
        );

        const amounts = await contract.getAmountsOut(amountIn, [tokenIn, tokenOut]);
        return amounts[1];
    } catch {
        return null;
    }
}

async function checkArbitrage() {
    const amountIn = ethers.parseUnits("100", 6); // 100 USDC

    const quick = await getPrice(ROUTERS.quickswap, TOKENS.USDC, TOKENS.USDT, amountIn);
    const sushi = await getPrice(ROUTERS.sushiswap, TOKENS.USDC, TOKENS.USDT, amountIn);

    if (!quick || !sushi) {
        console.log("❌ Price fetch failed");
        return;
    }

    console.log(`Quickswap: ${fmt(quick)} USDT`);
    console.log(`Sushiswap: ${fmt(sushi)} USDT`);

    const profit = Math.abs(Number(fmt(quick)) - Number(fmt(sushi)));

    console.log(`Potential Profit: ${profit.toFixed(6)} USDT`);

    if (profit > 0.01) {
        console.log("⚡ Executing simulated arbitrage...");
        vaultBalance += profit;
        totalProfit += profit;
        console.log(`Vault Balance: ${vaultBalance.toFixed(6)} USDT`);
        console.log(`Cumulative Net Profit: ${totalProfit.toFixed(6)} USDT\n`);
    } else {
        console.log("No profitable opportunity.\n");
    }
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------

console.log("-----------------------------------------------------");
console.log("  ARBITRAGE BOT STARTED");
console.log("  Network RPC:", RPC);
console.log("  Wallet:", wallet.address);
console.log("-----------------------------------------------------\n");

async function startBot() {
    while (true) {
        try {
            await checkArbitrage();
        } catch (err) {
            console.log("Runtime Error:", err.message);
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}

startBot();
