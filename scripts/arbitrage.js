import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73"
};

// Example tokens to scan for arbitrage
const tokens = [
  { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF" },
  { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39" },
  { symbol: "WBTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" }
];

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const MIN_PROFIT_USDC = ethers.utils.parseUnits("1", 6); // minimum 1 USDC profit

// ---------------- ABI ----------------
const arbAbi = [
    {
        "inputs": [
            { "internalType": "address", "name": "buyRouter", "type": "address" },
            { "internalType": "address", "name": "sellRouter", "type": "address" },
            { "internalType": "address", "name": "token", "type": "address" },
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
        ],
        "name": "executeArbitrage",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "_minProfit", "type": "uint256" }
        ],
        "name": "setMinProfit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "token", "type": "address" }
        ],
        "name": "withdrawProfit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "owner",
        "outputs": [
            { "internalType": "address", "name": "", "type": "address" }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

// ---------------- PROVIDER & CONTRACT ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ---------------- SIMULATED PRICE CHECK ----------------
// Replace with real on-chain or API prices
async function getPrice(router, tokenIn, tokenOut, amountIn) {
    // Here, just return fake numbers to simulate
    // In production, call router.getAmountsOut(amountIn, [tokenIn, tokenOut])
    return Math.random() * 10 + 1; // fake price
}

// ---------------- ARBITRAGE LOGIC ----------------
async function scanAndTrade() {
    console.log("🔍 Starting arbitrage scan...");
    
    for (let token of tokens) {
        for (let buyName in routers) {
            for (let sellName in routers) {
                if (buyName === sellName) continue;
                const buyRouter = routers[buyName];
                const sellRouter = routers[sellName];

                // Simulate prices
                const buyPrice = await getPrice(buyRouter, USDC, token.address, 1e6);
                const sellPrice = await getPrice(sellRouter, token.address, USDC, 1e6);

                const profit = sellPrice - buyPrice;
                const profitPercent = (profit / buyPrice) * 100;

                if (profit > 0) {
                    console.log(`🚨 ${token.symbol} | Buy:${buyName} @ $${buyPrice.toFixed(6)} → Sell:${sellName} @ $${sellPrice.toFixed(6)} | Estimated profit: ${profit.toFixed(6)} USDC (${profitPercent.toFixed(2)}%)`);
                    
                    try {
                        // Execute arbitrage on-chain
                        const tx = await arbContract.executeArbitrage(
                            buyRouter,
                            sellRouter,
                            token.address,
                            ethers.utils.parseUnits("10", 6) // borrow amount (10 USDC)
                        );
                        console.log("✅ Transaction submitted:", tx.hash);
                        await tx.wait();
                        console.log("✅ Transaction confirmed!");
                    } catch (err) {
                        console.log("⚠️ Trade failed or reverted:", err.reason || err);
                    }
                }
            }
        }
    }
}

// ---------------- RUN ----------------
(async () => {
    try {
        console.log("🚀 Aave Flash Arbitrage Bot running...");
        await scanAndTrade();
    } catch (err) {
        console.error("Bot error:", err);
    }
})();


