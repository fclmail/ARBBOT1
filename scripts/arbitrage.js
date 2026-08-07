import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PK missing");

// ===================== CONFIGURATION & CONSTANTS =====================
const RPC_URL = process.env.RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const CONTRACT_ADDRESS = "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958";

const provider = new ethers.WebSocketProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Token Addresses (Polygon)
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Keeping explicit reference matching contract core tokens
const WMATIC = "0x0d500B1d8e8eF31E21C99d1Db9A6444d3ADf1270";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const DAI = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";
const WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47d9Bf6d";

const TOKENS = {
    [USDC]: { symbol: "USDC", decimals: 6 },
    [USDCE]: { symbol: "USDCE", decimals: 6 },
    [WMATIC]: { symbol: "WMATIC", decimals: 18 },
    [WETH]: { symbol: "WETH", decimals: 18 },
    [USDT]: { symbol: "USDT", decimals: 6 },
    [DAI]: { symbol: "DAI", decimals: 18 },
    [WBTC]: { symbol: "WBTC", decimals: 8 }
};

const ROUTERS = {
    QuickSwap: "0xa5e0829cacedd8ffffe2562575a0c8742e14d14e",
    Sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const BASE_TRADE = ethers.parseUnits(".02", 6); // $100 USDC base size
const MIN_PROFIT = ethers.parseUnits("0.00001", 6); // $0.50 min profit threshold
const GAS_COST_USDC = ethers.parseUnits("0.00005", 6);

// Minimal ABIs
const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)"
];

const ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const VAULT_ABI = [
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC) external view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)"
];

const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
const vault = new ethers.Contract(CONTRACT_ADDRESS, VAULT_ABI, wallet);

// Helper for formatting
function fmt(val, decimals = 6) {
    return ethers.formatUnits(val, decimals);
}

function getSymbol(addr) {
    return TOKENS[addr] ? TOKENS[addr].symbol : addr.slice(0, 6);
}

// Quick quote helper
async function quote(routerAddress, amountIn, path) {
    try {
        const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
        const amounts = await router.getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    } catch (err) {
        return null;
    }
}

// ===================== ARBITRAGE SCANNER & EXECUTION =====================

async function findArbitrageOpportunity(router, path) {
    let currentAmount = BASE_TRADE;

    for (let i = 0; i < path.length - 1; i++) {
        const hopPath = [path[i], path[i + 1]];
        const nextOut = await quote(router, currentAmount, hopPath);
        if (!nextOut) return null;
        currentAmount = nextOut;
    }

    const profit = currentAmount - BASE_TRADE;
    if (profit <= 0n || profit < MIN_PROFIT) return null;

    const routeDescription = path.map(addr => getSymbol(addr)).join("->");
    console.log(`🔔 OPPORTUNITY FOUND | Route: ${routeDescription} | Profit: ${fmt(profit)} USDC`);

    // Split the multi-hop path cleanly into buy leg and sell leg matching the contract expectations
    const midIndex = Math.floor(path.length / 2);
    const pathToToken = path.slice(0, midIndex + 1);
    const pathToUSDC = path.slice(midIndex);

    return {
        router,
        amountIn: BASE_TRADE,
        buyPath: pathToToken,
        sellPath: pathToUSDC,
        expectedProfit: profit
    };
}

async function executeBatch(trades) {
    console.log("\n🔥 EXECUTING BATCH");

    try {
        const beforeBal = await usdc.balanceOf(CONTRACT_ADDRESS);

        let usedCapital = 0n;
        let expected = 0n;
        let usable = [];

        for (const t of trades) {
            if (usedCapital + t.amountIn > beforeBal) break;
            usedCapital += t.amountIn;
            expected += t.expectedProfit;
            usable.push(t);
        }

        if (usable.length === 0) {
            console.log("❌ SKIPPED: INSUFFICIENT CONTRACT CAPITAL\n");
            return;
        }

        if (expected < GAS_COST_USDC) {
            console.log("❌ SKIPPED: BELOW GAS\n");
            return;
        }

        const tx = await vault.executeFlashBatchArbitrage({
            buyRouters: usable.map(t => t.router),
            sellRouters: usable.map(t => t.router),
            amountsInUSDC: usable.map(t => t.amountIn),
            pathsToToken: usable.map(t => t.buyPath),
            pathsToUSDC: usable.map(t => t.sellPath),
            deadline: Math.floor(Date.now() / 1000) + 30
        });

        console.log(`TX SENT ${tx.hash}\n`);

        await provider.waitForTransaction(tx.hash);

        const afterBal = await usdc.balanceOf(CONTRACT_ADDRESS);

        const delta =
            afterBal > beforeBal
                ? afterBal - beforeBal
                : 0n;

        console.log(`CONTRACT BEFORE ${fmt(beforeBal)}`);
        console.log(`CONTRACT AFTER  ${fmt(afterBal)}`);
        console.log(`REAL PROFIT     ${fmt(delta)}\n`);

    } catch (err) {
        console.error("⚠️ BATCH EXECUTION REVERTED:", err.message);
    }
}

// Generate standard routing permutations
const paths = [
    [USDC, WMATIC, USDC],
    [USDC, WETH, USDC],
    [USDC, USDT, USDC],
    [USDC, DAI, USDC],
    [USDC, WBTC, USDC],
    [USDC, WMATIC, WETH, USDC],
    [USDC, WETH, WMATIC, USDC]
];

async function scanLoop() {
    let batchTrades = [];

    for (const [routerName, routerAddress] of Object.entries(ROUTERS)) {
        for (const path of paths) {
            const opp = await findArbitrageOpportunity(routerAddress, path);
            if (opp) {
                batchTrades.push(opp);
            }
        }
    }

    if (batchTrades.length > 0) {
        await executeBatch(batchTrades);
    }

    setTimeout(scanLoop, 1000);
}

provider.on("block", async (blockNumber) => {
    console.log(`📦 New Block: ${blockNumber}`);
});

console.log("🚀 Starting Optimized Arbitrage Bot Engine...");
scanLoop();
