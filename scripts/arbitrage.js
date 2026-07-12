import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// RPC Endpoints
const WSS_URL = "wss://polygon-bor-rpc.publicnode.com";

// Setup Wallet and Core Infrastructure Addresses
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const RAW_ROUTER_A = "0xa5E0829CaCEd8bFDD4De3c43696c57F7D7A678ff";       // QuickSwap Router
const RAW_ROUTER_B = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";       // SushiSwap Router
const RAW_ENFORCER_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc"; // Your Custom Contract
const RAW_USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";    // Bridged USDC.e (Ending in 4174)
const RAW_WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// Sanitized Address Checksum Targets
const ROUTER_A = ethers.getAddress(RAW_ROUTER_A.toLowerCase());
const ROUTER_B = ethers.getAddress(RAW_ROUTER_B.toLowerCase());
const ENFORCER_ADDRESS = ethers.getAddress(RAW_ENFORCER_ADDRESS.toLowerCase());
const USDCE_ADDRESS = ethers.getAddress(RAW_USDCE_ADDRESS.toLowerCase());
const WETH_ADDRESS = ethers.getAddress(RAW_WETH_ADDRESS.toLowerCase());

// Routing Array Structures
const pathToToken = [USDCE_ADDRESS, WETH_ADDRESS];
const pathToUSDC = [WETH_ADDRESS, USDCE_ADDRESS];

// Dynamic Trade Volume Options (Evaluated on-chain by your custom execution hook)
const CANDIDATE_SIZES = [
    ethers.parseUnits("100", 6),
    ethers.parseUnits("500", 6),
    ethers.parseUnits("1000", 6)
];

// Fallback Baseline Simulation Parameter (Single Trade Size Option)
const SINGLE_SIMULATION_SIZE = ethers.parseUnits("1000", 6);

const ENFORCER_ABI = [
    "function owner() view returns (address)",
    "function vault() view returns (address)",
    "function usdc() view returns (address)",
    "function minimumProfitUSDC() view returns (uint256)",
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

const engineState = {
    totalProfits: 0n,
    minimumProfitThreshold: 0n,
    totalBlocksChecked: 0,
    startTime: null
};

let provider;
let wallet;
let enforcerContract;
let tokenContract;
let keepAliveInterval;

function initWebSocketProvider(url) {
    const wsInstance = new ethers.WebSocketProvider(url);
    wsInstance.on("error", (err) => {
        console.error("⚠️ Active WebSocket Layer Error:", err.message || err);
    });
    return wsInstance;
}

async function initializeEngine() {
    console.log("============================================================");
    console.log("🚀 ARBBOT1 - PRODUCTION MATRIX FLASH LOAN ENGINE");
    console.log(`🌐 Infrastructure Context: Polygon Mainnet Execution Shard`);
    console.log(`📅 Timestamp: ${new Date().toLocaleString()}`);
    console.log("============================================================");

    provider = initWebSocketProvider(WSS_URL);
    
    // Core keep-alive ping layer to secure streaming channels
    keepAliveInterval = setInterval(async () => {
        try {
            await provider.getBlockNumber();
        } catch (err) {
            console.warn("⚠️ Telemetry link warning (ping dropout):", err.message);
        }
    }, 15000);

    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    enforcerContract = new ethers.Contract(ENFORCER_ADDRESS, ENFORCER_ABI, wallet);
    tokenContract = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, provider);

    console.log(`👤 Engine Node Wallet: ${wallet.address}`);
    console.log(`📋 On-Chain Enforcer Proxy: ${enforcerContract.target}`);

    const contractAssetBalance = await tokenContract.balanceOf(enforcerContract.target);
    const configuredMinProfit = await enforcerContract.minimumProfitUSDC();
    const assetDecimals = await tokenContract.decimals();
    const assetSymbol = await tokenContract.symbol();

    console.log(`🏦 Current Target Balance: ${ethers.formatUnits(contractAssetBalance, assetDecimals)} ${assetSymbol}`);
    console.log(`💰 Configured On-Chain Minimum Profit Requirement: ${ethers.formatUnits(configuredMinProfit, assetDecimals)} ${assetSymbol}`);

    engineState.minimumProfitThreshold = configuredMinProfit;
    engineState.startTime = Date.now();

    console.log("✅ State Matrix verified. Streaming active...");
    registerContractEvents();
}

function registerContractEvents() {
    enforcerContract.on("ArbitrageExecuted", (buyRouter, sellRouter, token, amountIn, beforeBal, afterBal, profitUSDC) => {
        engineState.totalProfits += profitUSDC;
        console.log(`\n🎉 [SETTLEMENT EVENT] Trade Executed Successfully On-Chain!`);
        console.log(`📈 Net Yield Captured: +${ethers.formatUnits(profitUSDC, 6)} USDC.e`);
    });
}

async function evaluateBlockState(blockNumber) {
    engineState.totalBlocksChecked++;
    
    try {
        // Run pre-flight checks using a clean view static call simulation
        const [estimatedFinalUSDC, estimatedProfit] = await enforcerContract.simulateArbitrageProfit(
            ROUTER_A,
            ROUTER_B,
            SINGLE_SIMULATION_SIZE,
            pathToToken,
            pathToUSDC
        );

        // If the route returns a profitable spread over your local target
        if (estimatedProfit > engineState.minimumProfitThreshold) {
            console.log(`📦 [BLOCK #${blockNumber}] 🔥 Divergence Discovered! Net profit target met: +${ethers.formatUnits(estimatedProfit, 6)} USDC.e`);
            
            const transactionDeadline = Math.floor(Date.now() / 1000) + 60;
            
            // Dispatch high-priority transaction covering multiple batch candidates
            const tx = await enforcerContract.executeBestFlashLoanArbitrage(
                ROUTER_A,
                ROUTER_B,
                CANDIDATE_SIZES,
                pathToToken,
                pathToUSDC,
                transactionDeadline,
                { gasLimit: 800000 }
            );
            
            console.log(`🚀 Settlement pipeline dispatched! Hash: ${tx.hash}`);
            await tx.wait();
        } else {
            console.log(`📦 [BLOCK #${blockNumber}] ℹ️ Micro-divergence flagged, but variance below target threshold.`);
        }

    } catch (err) {
        // Catches contract execution reverts cleanly when pricing layers are correlated
        if (err.code === "CALL_EXCEPTION" || err.message.includes("reverted")) {
            console.log(`📦 [BLOCK #${blockNumber}] ℹ️ System scanning. No profitable arbitrage divergence present.`);
        } else {
            console.error(`📦 [BLOCK #${blockNumber}] ⚠️ Processing Layer Alert:`, err.message);
        }
    }
}

async function main() {
    try {
        await initializeEngine();
        
        provider.on("block", async (blockNumber) => {
            await evaluateBlockState(blockNumber);
        });
        console.log("📡 WebSocket Event Stream Cluster listening...");

    } catch (criticalFailure) {
        console.error("\n❌ Initialization Vector Aborted:", criticalFailure.message);
        emergencyExit();
    }
}

function emergencyExit() {
    clearInterval(keepAliveInterval);
    process.exit(0);
}

process.on("SIGINT", emergencyExit);
process.on("SIGTERM", emergencyExit);

main();
