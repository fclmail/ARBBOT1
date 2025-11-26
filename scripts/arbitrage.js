import { ethers } from "ethers";
import {
    getTokenPrice,
    estimateProfit,
    performArbitrageSwap,
    getVaultUSDCBalance
} from "./helpers.js";

// LIVE MODE ENABLED
const DRY_RUN = false;

// SETTINGS
const MIN_EXPECTED_PROFIT_USDC = ethers.parseUnits("0.20", 6); // must beat gas
const TRADE_AMOUNT = ethers.parseUnits("0.05", 6); // 🟢 Modified
const TOKENS = [
    {
        symbol: "WETH",
        address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
    },
    {
        symbol: "WBTC",
        address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
    },
    {
        symbol: "CRV",
        address: "0x172370d5cd63279efa6d502dab29171933a610af"
    }
];

// DEX ROUTERS
const QUICKSWAP = "0xa5E0829caced8fFDd4De3c43696c57F7D7A678ff";
const SUSHISWAP = "0x1b02dA8Cb0d097eB8D57a175b88c7D8b47997506";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

async function checkArb(token, dexBuy, dexSell) {
    if (dexBuy === dexSell) return; // ⛔ prevents IDENTICAL_ADDRESSES revert

    const vaultBalance = await getVaultUSDCBalance(wallet);
    if (vaultBalance < TRADE_AMOUNT) {
        console.warn("⚠️ Vault balance too low.");
        return;
    }

    const { buyPrice, sellPrice } = await getTokenPrice(
        token.address,
        dexBuy,
        dexSell,
        TRADE_AMOUNT,
        provider
    );

    const estProfit = await estimateProfit(
        token.address,
        dexBuy,
        dexSell,
        TRADE_AMOUNT,
        provider
    );

    console.log(
        `💹 ${token.symbol} ${dexBuy === QUICKSWAP ? "QuickSwap" : "SushiSwap"}->${dexSell === QUICKSWAP ? "QuickSwap" : "SushiSwap"} estProfit ${Number(ethers.formatUnits(estProfit, 6)).toFixed(6)} USDC`
        + (estProfit >= MIN_EXPECTED_PROFIT_USDC ? " 🚨" : " | skipped")
    );

    if (estProfit < MIN_EXPECTED_PROFIT_USDC) return;

    console.log(`🚨 Arbitrage detected: ${token.symbol} profitable!`);

    if (!DRY_RUN) {
        await performArbitrageSwap(
            token.address,
            dexBuy,
            dexSell,
            TRADE_AMOUNT,
            estProfit,
            wallet
        );
    }
}

async function run() {
    console.log("🚀 Arbitrage bot started (LIVE)\n");

    while (true) {
        console.log("🔍 Scanning for arbitrage opportunities...");

        for (const token of TOKENS) {
            await checkArb(token, QUICKSWAP, SUSHISWAP);
            await checkArb(token, SUSHISWAP, QUICKSWAP);
        }

        await new Promise(r => setTimeout(r, 5000));
    }
}

run().catch(console.error);
