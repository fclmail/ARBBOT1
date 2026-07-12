import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// Swapped configuration variables to prioritize the direct Polygon Bor gateway architecture
const WSS_URL = "wss://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Raw Configuration Strings (Safe from top-level ESM module parsing constraints)
const RAW_ROUTER_A = "0xa5E0829CaCEd8bFDD4De3c43696c57F7D7A678ff"; // QuickSwap Router
const RAW_ROUTER_B = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap Router
const RAW_ENFORCER_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const RAW_USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Polygon USDC
const RAW_WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// Properly checksummed variables assigned dynamically during async initialization
let ROUTER_A, ROUTER_B, ENFORCER_ADDRESS, USDC_ADDRESS, WETH_ADDRESS;
let pathToToken, pathToUSDC;
const tradeSize = ethers.parseUnits("1000", 6); // Test candidate size: 1000 USDC

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

    // Compute compliant lower/mixed case checksum addresses safely at execution time
    ROUTER_A = ethers.getAddress(RAW_ROUTER_A.toLowerCase());
    ROUTER_B = ethers.getAddress(RAW_ROUTER_B.toLowerCase());
    ENFORCER_ADDRESS = ethers.getAddress(RAW_ENFORCER_ADDRESS.toLowerCase());
    USDC_ADDRESS = ethers.getAddress(RAW_USDC_ADDRESS.toLowerCase());
    WETH_ADDRESS = ethers.getAddress(RAW_WETH_ADDRESS.toLowerCase());

    // Initialize paths once checksums are set
    pathToToken = [USDC_ADDRESS, WETH_ADDRESS];
    pathToUSDC = [WETH_ADDRESS, USDC_ADDRESS];

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

    // Quiet initialization of logs. If public node rejects the query, we bypass silently.
    let calculatedTotalProfits = 0n;
    try {
        const filter = enforcerContract.filters.ArbitrageExecuted();
        const currentBlock = await provider.getBlockNumber();
        const events = await enforcerContract.queryFilter(filter, currentBlock - 100, currentBlock);
        
        for (const event of events) {
            calculatedTotalProfits += event.args.profitUSDC;
        }
    } catch (error) {
        // Suppress noisy output for public RPC index limits
    }

    contractState.totalProfits = calculatedTotalProfits;
    contractState.minimumProfit = minProfit;
    contractState.startTime = Date.now();

    console.log(`📈 Historically Accumulated Profit: ${ethers.formatUnits(calculatedTotalProfits, decimals)} USDC`);
    console.log("✅ Initialization successful. Real-time scanning engaged.");
    
    setupEventListeners();
}

function setupEventListeners() {
    // Utilize native event hooks that stream cleanly over WebSockets without calling eth_getLogs
    enforcerContract.on("ArbitrageExecuted", (buyRouter, sellRouter, token, amountIn, beforeBal, afterBal, profitUSDC) => {
        contractState.totalProfits += profitUSDC;
        console.log(`\n🎉 [EVENT] Trade Success logged on-chain! Net Profit: +${ethers.formatUnits(profitUSDC, 6)} USDC`);
        console.log(`📈 Updated Total Accumulated Profit: ${ethers.formatUnits(contractState.totalProfits, 6)} USDC\n`);
    });
}

async function processBlock(blockNumber) {
    contractState.totalAttempts++;
    console.log(`📦 [BLOCK] Processing Mainnet Block #${blockNumber} | Total Checked: ${contractState.totalAttempts}`);

    try {
        // 1. Simulates price variance across target DEX routers on-chain
        const [estimatedFinalUSDC, estimatedProfit] = await enforcerContract.simulateArbitrageProfit(
            ROUTER_A,
            ROUTER_B,
            tradeSize,
            pathToToken,
            pathToUSDC
        );

        // 2. Evaluate if simulated return passes target threshold limits
        if (estimatedProfit > contractState.minimumProfit) {
            console.log(`🔥 Profitable Opportunity Detected! Profit Margin: +${ethers.formatUnits(estimatedProfit, 6)} USDC. Sending Flash Loan Execution Payload...`);
            
            const deadline = Math.floor(Date.now() / 1000) + 60; // 1-minute transaction execution deadline
            
            // Send the signed transaction straight to the network enforcer contract
            const tx = await enforcerContract.executeAaveFlashLoanArbitrage(
                ROUTER_A,
                ROUTER_B,
                tradeSize,
                pathToToken,
                pathToUSDC,
                deadline
            );
            
            console.log(`🚀 Transaction Dispatched! Hash: ${tx.hash}`);
            await tx.wait(); // Pause thread synchronously until execution is verified in a block
            console.log(`✅ Transaction fully settled in block.`);
        }

    } catch (err) {
        // Suppress errors caused by standard lack of market divergence or transient public node dropouts
        console.debug(`ℹ️ Block simulation skipped or no path divergence:`, err.message);
    }
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
        console.log("📡 Subscribed via WebSocket block event streams successfully.");

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
