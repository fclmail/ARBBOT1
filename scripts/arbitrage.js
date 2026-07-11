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
    startTime: null,
    lastCheckedBlock: 0
};

let provider;
let wallet;
let enforcerContract;
let usdcContract;
let pingInterval;
let fallbackPollInterval;

// Clean Ethers v6 Provider instantiation 
function createWebSocketProvider(url) {
    const wsProvider = new ethers.WebSocketProvider(url);

    wsProvider.on("error", (err) => {
        console.error("⚠️ WebSocket provider error:", err.message || err);
    });

    return wsProvider;
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
    
    // Native Ethers v6 keep-alive using standard provider calls instead of hidden properties
    pingInterval = setInterval(async () => {
        try {
            await provider.getBlockNumber();
        } catch (err) {
            console.warn("⚠️ Keep-alive ping failed:", err.message);
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

    // Dynamic historical tracking safe from public rate limits
    let calculatedTotalProfits = 0n;
    let currentBlock = 0;
    try {
        const filter = enforcerContract.filters.ArbitrageExecuted();
        currentBlock = await provider.getBlockNumber();
        contractState.lastCheckedBlock = currentBlock;
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
    console.log("✅ Initialization successful. Real-time scanning engaged.");
}

// Manual event block scanner to bypass public node subscription restrictions
async function checkEventsForBlockRange(fromBlock, toBlock) {
    try {
        const filter = enforcerContract.filters.ArbitrageExecuted();
        const events = await enforcerContract.queryFilter(filter, fromBlock, toBlock);
        for (const event of events) {
            contractState.totalProfits += event.args.profitUSDC;
            console.log(`\n🎉 [EVENT] Trade Success logged on-chain! Net Profit: +${ethers.formatUnits(event.args.profitUSDC, 6)} USDC`);
            console.log(`📈 Updated Total Accumulated Profit: ${ethers.formatUnits(contractState.totalProfits, 6)} USDC\n`);
        }
    } catch (err) {
        console.debug("ℹ️ Event log poll skipped or rate limited:", err.message);
    }
}

async function processBlock(blockNumber) {
    contractState.totalAttempts++;
    // Mempool verification / router strategy payload evaluations go here...
}

async function main() {
    try {
        await initialize();
        
        // Attempt Native WebSocket Subscription, Fallback gracefully to Polling if public node rejects it
        try {
            provider.on("block", async (blockNumber) => {
                try {
                    await processBlock(blockNumber);
                    // Accompany real-time block streams with event log matching
                    await checkEventsForBlockRange(blockNumber, blockNumber);
                } catch (err) {
                    console.error(`❌ Error parsing block ${blockNumber}:`, err.message);
                }
            });
            console.log("📡 Subscribed via WebSocket block event streams stream successfully.");
        } catch (subError) {
            console.warn("⚠️ WebSocket subscription rejected by Bor endpoint. Initiating high-frequency Polling fallback (2s intervals)...");
            
            fallbackPollInterval = setInterval(async () => {
                try {
                    const currentBlock = await provider.getBlockNumber();
                    if (currentBlock > contractState.lastCheckedBlock) {
                        for (let b = contractState.lastCheckedBlock + 1; b <= currentBlock; b++) {
                            await processBlock(b);
                        }
                        await checkEventsForBlockRange(contractState.lastCheckedBlock + 1, currentBlock);
                        contractState.lastCheckedBlock = currentBlock;
                    }
                } catch (pollErr) {
                    console.error("❌ Fallback block check engine error:", pollErr.message);
                }
            }, 2000); 
        }

    } catch (fatalError) {
        console.error("\n❌ Fatal Error during runtime initialization:", fatalError.message);
        shutdown();
    }
}

function shutdown() {
    clearInterval(pingInterval);
    if (fallbackPollInterval) clearInterval(fallbackPollInterval);
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
