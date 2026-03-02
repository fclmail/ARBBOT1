// scripts/arbitrage.js
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length !== 66) {
    throw new Error("Invalid PRIVATE_KEY secret.");
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("🚀 Starting arbitrage bot (ES module)");
console.log("💰 Wallet address:", wallet.address);

// --- TOKENS ---
const TOKENS = {
    USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
    WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
    WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
};

const ROUTERS = [
    "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
];

const HOP_PATHS = [
    [TOKENS.USDC.address, TOKENS.WMATIC.address, TOKENS.WETH.address, TOKENS.USDC.address],
];

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)"
];

// --- MAIN LOOP ---
async function runBot() {
    while (true) {
        try {
            await scan();
        } catch (err) {
            console.log("❌ Scan error:", err.message);
        }

        console.log("\n🔄 Next scan in 10 seconds...\n");
        await new Promise(res => setTimeout(res, 10000));
    }
}

async function scan() {
    const balances = {};

    for (const [symbol, token] of Object.entries(TOKENS)) {
        const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
        const balance = await contract.balanceOf(wallet.address);
        balances[symbol] = ethers.formatUnits(balance, token.decimals);
    }

    console.log("💰 Current balances:");
    for (const [symbol, amount] of Object.entries(balances)) {
        console.log(`   ${symbol}: ${amount}`);
    }

    console.log("\n🔄 Scanning routers for profitable swaps...");

    for (const routerAddress of ROUTERS) {
        for (const path of HOP_PATHS) {

            console.log(
                `🧮 Checking path: ${path.map(getSymbolByAddress).join(" -> ")} on Router: ${routerAddress}`
            );

            try {
                const quoteProfit = await simulateArb();

                if (quoteProfit > 0n) {
                    console.log(`⚡ Profit opportunity detected: ${ethers.formatUnits(quoteProfit, 6)} USDC`);
                    console.log("⏳ Executing swap...");
                    await executeSwap();
                    console.log("✅ Swap completed");
                } else {
                    console.log("⚠️ No profitable arbitrage opportunity found");
                }

            } catch (err) {
                console.log("❌ Error checking/executing path:", err.message);
            }
        }
    }
}

function getSymbolByAddress(address) {
    for (const [symbol, token] of Object.entries(TOKENS)) {
        if (token.address.toLowerCase() === address.toLowerCase()) return symbol;
    }
    return "UNKNOWN";
}

// --- MOCK ARB SIMULATION ---
async function simulateArb() {
    return Math.random() > 0.7
        ? ethers.parseUnits("0.5", 6)   // 0.5 USDC profit
        : 0n;
}

async function executeSwap() {
    await new Promise(res => setTimeout(res, 1000));
}

runBot();
