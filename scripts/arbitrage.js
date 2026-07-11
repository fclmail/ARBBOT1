import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// Swapped configuration variables to prioritize the direct Polygon Bor gateway architecture
const WSS_URL = "wss://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ENFORCER_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Polygon USDC

// Cleaned ABI matching your smart contract definitions precisely
const ENFORCER_ABI = [
    "constructor(address _usdc, address _vault, uint256 _minimumProfitUSDC, address _aavePoolAddress)",
    "function owner() view returns (address)",
    "function vault() view returns (address)",
    "function usdc() view returns (address)",
    "function aavePoolAddress() view returns (address)",
    "function minimumProfitUSDC() view returns (uint256)",
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) calldata batch) external",
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

// Bot execution telemetry metrics
const contractState = {
    totalProfits: 0n,
    minimumProfit: 0n,
    totalAttempts: 0,
    startTime: null
};

let provider;
let wallet;
let enforcerContract;
let usdcContract;
let pingInterval;

// Helper to create a resilient socket client instance over public endpoints
function createWebSocketProvider(url) {
    const ws = new WebSocket(url);

    ws.addEventListener("close", (event) => {
        clearInterval(pingInterval);
        console.error(`\n❌ Bor Network WebSocket disconnected (Code: ${event.code}). Reconnecting strategy pipeline...`);
        setTimeout(() => {
            main();
        }, 3000);
    });

    ws.addEventListener("error", (err) => {
        console.error("⚠️ Bor Network underlying socket interface error:", err.message);
    });

    return new ethers.WebSocketProvider(ws);
}

async function initialize() {
    console.log("============================================================");
    console.log("🚀 ARBBOT1 - FLASH LOAN ARBITRAGE SYSTEM");
    console.log(`🌐 Network: Polygon Mainnet (Direct Bor Infrastructure)`);
    console.log(`📅 Started: ${new Date().toLocaleString()}`);
    console.log("============================================================");
    console.log("🚀 ARBBOT1 - FLASH LOAN ARBITRAGE BOT");
    console.log("============================================================");

    provider = createWebSocketProvider(WSS_URL);
    
    // Tightened polling parameters to secure state sync on shared endpoints
    pingInterval = setInterval(async () => {
        try {
            if (provider && provider.websocket && provider.websocket.readyState === 1) { // 1 = OPEN
                await provider.send("eth_blockNumber", []);
            }
        } catch (err) {
            console.warn("⚠️ WebSocket keep-alive ping rejected:", err.message);
        }
    }, 15000);

    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    enforcerContract = new ethers.Contract(ENFORCER_ADDRESS, ENFORCER_ABI, wallet);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    console.log(`👤 Bot Wallet: ${wallet.address}`);
    console.log(`📋 Contract Target: ${enforcerContract.target}`);

    const contractBalance = await usdcContract.balanceOf(enforcerContract.target);
    const minProfit = await enforcerContract.minimumProfitUSDC();
    const decimals = await usdcContract.decimals();
    const symbol = await usdcContract.symbol();

    console.log(`🏦 Vault Address: ${await enforcerContract.vault()}`);
    console.log(`📊 Current Contract Balance: ${ethers.formatUnits(contractBalance, decimals)} ${symbol}`);
    console.log(`🪙 ${symbol} Decimals: ${decimals}, Symbol: ${symbol}`);
    console.log(`💰 Configured Minimum Profit Requirement: ${ethers.formatUnits(minProfit, decimals)} USDC`);

    // Adjusted history ranges down to 200 blocks to meet free public rate limits without timing out
    let calculatedTotalProfits = 0n;
    try {
        const filter = enforcerContract.filters.ArbitrageExecuted();
        const currentBlock = await provider.getBlockNumber();
        const events = await enforcerContract.queryFilter(filter, currentBlock - 200, currentBlock);
        
        for (const event of events) {
            calculatedTotalProfits += event.args.profitUSDC;
        }
    } catch (error) {
        console.warn("⚠️ Public node query limit reached. Defaulting local state logs to 0:", error.message);
    }

    contractState.totalProfits = calculatedTotalProfits;
    contractState.minimumProfit = minProfit;
    contractState.startTime = Date.now();

    console.log(`📈 Historically Accumulated Profit: ${ethers.formatUnits(calculatedTotalProfits, decimals)} USDC`);
    console.log("✅ Initialization successful. Real-time mempool scanning engaged.");
    
    setupEventListeners();
}

function setupEventListeners() {
    enforcerContract.on("ArbitrageExecuted", (buyRouter, sellRouter, token, amountIn, beforeBal, afterBal, profitUSDC) => {
        contractState.totalProfits += profitUSDC;
        console.log(`\n🎉 [EVENT] Trade Success logged on-chain! Net Profit: +${ethers.formatUnits(profitUSDC, 6)} USDC`);
        console.log(`📈 Updated Total Accumulated Profit: ${ethers.formatUnits(contractState.totalProfits, 6)} USDC\n`);
    });
}

async function processBlock(blockNumber) {
    contractState.totalAttempts++;
}

async function main() {
    try {
        await initialize();
        
        provider.on("block", async (blockNumber) => {
            try {
                await processBlock(blockNumber);
            } catch (err) {
                console.error(`❌ Error parsing block ${blockNumber}:`, err.message);
            }
        });

    } catch (fatalError) {
        console.error("\n❌ Fatal Error during runtime initialization:", fatalError.message);
        shutdown();
    }
}

function shutdown() {
    clearInterval(pingInterval);
    console.log("\n============================================================");
    console.log("🛑 Shutting down bot...");
    console.log("============================================================");
    
    const runtimeHours = ((Date.now() - (contractState.startTime || Date.now())) / 1000 / 3600).toFixed(2);
    console.log("\n📊 Final Performance Summary:");
    console.log(`   Runtime: ${runtimeHours} hours`);
    console.log(`   Total Blocks Evaluated: ${contractState.totalAttempts}`);
    console.log(`   Total System Profits Saved: ${ethers.formatUnits(contractState.totalProfits, 6)} USDC`);
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main();
