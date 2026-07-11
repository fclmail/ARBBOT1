import { ethers } from "ethers";  
import dotenv from "dotenv";  
dotenv.config();  

// ============================================================  
// CONFIGURATION  
// ============================================================  
const WSS_URL = "wss://polygon-bor-rpc.publicnode.com";  
const PRIVATE_KEY = process.env.PRIVATE_KEY;  
const ENFORCER_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";  
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Polygon USDC  
const BLOCK_LOOKBACK = 100; // Blocks to scan for historical profits  
const RECONNECT_DELAY = 5000; // ms  
const PING_INTERVAL = 15000; // ms  
const FLASH_LOAN_DEADLINE_BUFFER = 2; // blocks  

// ============================================================  
// SMART CONTRACT ABIs  
// ============================================================  
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

// ============================================================  
// ROUTER PAIRS CONFIGURATION  
// Add your known router addresses and token paths here  
// ============================================================  
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";  
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";  
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";  
const DAI = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";  

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";  
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";  

// Define arbitrage router pairs to check  
const ROUTER_PAIRS = [  
    // Quickswap -> SushiSwap: USDC -> WMATIC -> USDC  
    {  
        buyRouter: QUICKSWAP_ROUTER,  
        sellRouter: SUSHISWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, WMATIC],  
        pathToUSDC: [WMATIC, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6, 50000e6] // 1000, 5000, 10000, 25000, 50000 USDC  
    },  
    // SushiSwap -> Quickswap: USDC -> WMATIC -> USDC  
    {  
        buyRouter: SUSHISWAP_ROUTER,  
        sellRouter: QUICKSWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, WMATIC],  
        pathToUSDC: [WMATIC, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6, 50000e6]  
    },  
    // Quickswap -> SushiSwap: USDC -> WETH -> USDC  
    {  
        buyRouter: QUICKSWAP_ROUTER,  
        sellRouter: SUSHISWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, WETH],  
        pathToUSDC: [WETH, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6]  
    },  
    // SushiSwap -> Quickswap: USDC -> WETH -> USDC  
    {  
        buyRouter: SUSHISWAP_ROUTER,  
        sellRouter: QUICKSWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, WETH],  
        pathToUSDC: [WETH, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6]  
    },  
    // Quickswap -> SushiSwap: USDC -> USDT -> USDC  
    {  
        buyRouter: QUICKSWAP_ROUTER,  
        sellRouter: SUSHISWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, USDT],  
        pathToUSDC: [USDT, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6, 50000e6, 100000e6]  
    },  
    // SushiSwap -> Quickswap: USDC -> USDT -> USDC  
    {  
        buyRouter: SUSHISWAP_ROUTER,  
        sellRouter: QUICKSWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, USDT],  
        pathToUSDC: [USDT, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6, 50000e6, 100000e6]  
    },  
    // Quickswap -> SushiSwap: USDC -> DAI -> USDC  
    {  
        buyRouter: QUICKSWAP_ROUTER,  
        sellRouter: SUSHISWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, DAI],  
        pathToUSDC: [DAI, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6, 50000e6]  
    },  
    // SushiSwap -> Quickswap: USDC -> DAI -> USDC  
    {  
        buyRouter: SUSHISWAP_ROUTER,  
        sellRouter: QUICKSWAP_ROUTER,  
        pathToToken: [USDC_ADDRESS, DAI],  
        pathToUSDC: [DAI, USDC_ADDRESS],  
        candidateSizes: [1000e6, 5000e6, 10000e6, 25000e6, 50000e6]  
    }  
];  

// ============================================================  
// BOT STATE  
// ============================================================  
const contractState = {  
    totalProfits: 0n,  
    minimumProfit: 0n,  
    totalAttempts: 0,  
    totalExecutions: 0,  
    successfulExecutions: 0,  
    failedExecutions: 0,  
    startTime: null,  
    startBlock: 0  
};  

let provider;  
let wallet;  
let enforcerContract;  
let usdcContract;  
let pingInterval;  
let isShuttingDown = false;  
let decimals = 6;  
let symbol = "USDC";  

// ============================================================  
// WEBSOCKET PROVIDER WITH RECONNECTION  
// ============================================================  
function createWebSocketProvider(url) {  
    const wsProvider = new ethers.WebSocketProvider(url);  

    wsProvider.on("error", (err) => {  
        console.error("⚠️ WebSocket provider error:", err.message || err);  
    });  

    // Handle WebSocket close events for automatic reconnection  
    if (wsProvider._websocket) {  
        wsProvider._websocket.on("close", async () => {  
            if (isShuttingDown) return;  
            console.log("\n⚠️ WebSocket connection closed. Reconnecting in 5 seconds...");  
            clearInterval(pingInterval);  
            await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));  
            if (!isShuttingDown) {  
                await reinitialize();  
            }  
        });  
    }  

    return wsProvider;  
}  

// ============================================================  
// RECONNECTION LOGIC  
// ============================================================  
async function reinitialize() {  
    try {  
        console.log("🔄 Attempting reconnection...");  
        provider.removeAllListeners("block");  
        enforcerContract.removeAllListeners("ArbitrageExecuted");  
        
        provider = createWebSocketProvider(WSS_URL);  
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);  
        enforcerContract = new ethers.Contract(ENFORCER_ADDRESS, ENFORCER_ABI, wallet);  
        usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);  
        
        // Restart keep-alive  
        pingInterval = setInterval(async () => {  
            try {  
                await provider.getBlockNumber();  
            } catch (err) {  
                console.warn("⚠️ Keep-alive ping failed:", err.message);  
            }  
        }, PING_INTERVAL);  
        
        // Re-setup event listeners  
        setupEventListeners();  
        
        // Re-subscribe to blocks  
        provider.on("block", async (blockNumber) => {  
            try {  
                await processBlock(blockNumber);  
            } catch (err) {  
                console.error(`❌ Error parsing block ${blockNumber}:`, err.message);  
            }  
        });  
        
        console.log("✅ Reconnection successful. Resuming operations.");  
    } catch (err) {  
        console.error("❌ Reconnection failed:", err.message);  
        if (!isShuttingDown) {  
            console.log("⏳ Retrying in 10 seconds...");  
            await new Promise(resolve => setTimeout(resolve, 10000));  
            await reinitialize();  
        }  
    }  
}  

// ============================================================  
// INITIALIZATION  
// ============================================================  
async function initialize() {  
    console.log("============================================================");  
    console.log("🚀 ARBBOT1 - FLASH LOAN ARBITRAGE SYSTEM");  
    console.log(`🌐 Network: Polygon Mainnet (Direct Bor Infrastructure)`);  
    console.log(`📅 Started: ${new Date().toLocaleString()}`);  
    console.log("============================================================");  

    provider = createWebSocketProvider(WSS_URL);  
    
    // Native Ethers v6 keep-alive  
    pingInterval = setInterval(async () => {  
        try {  
            await provider.getBlockNumber();  
        } catch (err) {  
            console.warn("⚠️ Keep-alive ping failed:", err.message);  
        }  
    }, PING_INTERVAL);  

    wallet = new ethers.Wallet(PRIVATE_KEY, provider);  
    enforcerContract = new ethers.Contract(ENFORCER_ADDRESS, ENFORCER_ABI, wallet);  
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);  

    console.log(`👤 Bot Wallet: ${wallet.address}`);  
    console.log(`📋 Contract Target: ${enforcerContract.target}`);  

    // Fetch on-chain state  
    const contractBalance = await usdcContract.balanceOf(enforcerContract.target);  
    const minProfit = await enforcerContract.minimumProfitUSDC();  
    decimals = await usdcContract.decimals();  
    symbol = await usdcContract.symbol();  
    const currentBlock = await provider.getBlockNumber();  

    console.log(`🏦 Vault Address: ${await enforcerContract.vault()}`);  
    console.log(`📊 Current Contract Balance: ${ethers.formatUnits(contractBalance, decimals)} ${symbol}`);  
    console.log(`🪙 ${symbol} Decimals: ${decimals}`);  
    console.log(`💰 Configured Minimum Profit Requirement: ${ethers.formatUnits(minProfit, decimals)} USDC`);  

    // Calculate historical profits with proper block filtering  
    let calculatedTotalProfits = 0n;  
    try {  
        const filter = enforcerContract.filters.ArbitrageExecuted();  
        const fromBlock = Math.max(0, currentBlock - BLOCK_LOOKBACK);  
        const events = await enforcerContract.queryFilter(filter, fromBlock, currentBlock);  
        
        for (const event of events) {  
            calculatedTotalProfits += event.args.profitUSDC;  
        }  
        console.log(`📜 Scanned ${events.length} historical events (blocks ${fromBlock} - ${currentBlock})`);  
    } catch (error) {  
        console.warn("⚠️ Could not fetch historical events (public RPC limits):", error.message);  
    }  

    contractState.totalProfits = calculatedTotalProfits;  
    contractState.minimumProfit = minProfit;  
    contractState.startTime = Date.now();  
    contractState.startBlock = currentBlock;  

    console.log(`📈 Historically Accumulated Profit (last ${BLOCK_LOOKBACK} blocks): ${ethers.formatUnits(calculatedTotalProfits, decimals)} USDC`);  
    console.log(`🔢 Starting at block: ${currentBlock}`);  
    console.log("✅ Initialization successful. Real-time scanning engaged.\n");  
    
    setupEventListeners();  
}  

// ============================================================  
// EVENT LISTENERS  
// ============================================================  
function setupEventListeners() {  
    enforcerContract.on("ArbitrageExecuted", (buyRouter, sellRouter, token, amountIn, beforeBal, afterBal, profitUSDC, event) => {  
        contractState.totalExecutions++;  
        
        // Only count profits from events after bot started to avoid double-counting  
        if (event.blockNumber >= contractState.startBlock) {  
            contractState.totalProfits += profitUSDC;  
            contractState.successfulExecutions++;  
            
            console.log(`\n🎉 [EVENT] Trade Success logged on-chain!`);  
            console.log(`   Block: ${event.blockNumber}`);  
            console.log(`   Buy Router: ${buyRouter}`);  
            console.log(`   Sell Router: ${sellRouter}`);  
            console.log(`   Token: ${token}`);  
            console.log(`   Amount In: ${ethers.formatUnits(amountIn, 6)} USDC`);  
            console.log(`   Net Profit: +${ethers.formatUnits(profitUSDC, 6)} USDC`);  
            console.log(`📈 Updated Total Accumulated Profit: ${ethers.formatUnits(contractState.totalProfits, 6)} USDC\n`);  
        } else {  
            console.log(`\n📜 [HISTORICAL EVENT] Block ${event.blockNumber} - Profit: ${ethers.formatUnits(profitUSDC, 6)} USDC (not counted in running total)\n`);  
        }  
    });  
}  

// ============================================================  
// OPPORTUNITY DETECTION & EXECUTION  
// ============================================================  
async function simulateAndExecute(routerPair, blockNumber) {  
    const { buyRouter, sellRouter, pathToToken, pathToUSDC, candidateSizes } = routerPair;  
    
    try {  
        // Simulate with the best candidate size (largest first)  
        const sortedSizes = [...candidateSizes].sort((a, b) => b - a);  
        
        for (const amountInUSDC of sortedSizes) {  
            const [estimatedFinalUSDC, estimatedProfit] = await enforcerContract.simulateArbitrageProfit(  
                buyRouter,  
                sellRouter,  
                amountInUSDC,  
                pathToToken,  
                pathToUSDC  
            );  
            
            if (estimatedProfit > contractState.minimumProfit) {  
                console.log(`\n💰 PROFITABLE OPPORTUNITY FOUND!`);  
                console.log(`   Block: ${blockNumber}`);  
                console.log(`   Buy Router: ${buyRouter}`);  
                console.log(`   Sell Router: ${sellRouter}`);  
                console.log(`   Amount: ${ethers.formatUnits(amountInUSDC, 6)} USDC`);  
                console.log(`   Estimated Profit: ${ethers.formatUnits(estimatedProfit, 6)} USDC`);  
                console.log(`   Path: ${pathToToken.join(" -> ")} | ${pathToUSDC.join(" -> ")}`);  
                
                // Execute the arbitrage  
                await executeArbitrage(routerPair, amountInUSDC, estimatedProfit, blockNumber);  
                return true; // Executed successfully  
            }  
        }  
    } catch (err) {  
        // Silently skip failed simulations (e.g., liquidity insufficient, path not found)  
        return false;  
    }  
    
    return false;  
}  

async function executeArbitrage(routerPair, amountInUSDC, estimatedProfit, blockNumber) {  
    const { buyRouter, sellRouter, pathToToken, pathToUSDC } = routerPair;  
    const deadline = blockNumber + FLASH_LOAN_DEADLINE_BUFFER;  
    
    try {  
        console.log(`🚀 Executing flash loan arbitrage...`);  
        console.log(`   Deadline block: ${deadline}`);  
        
        // Check wallet has enough MATIC for gas  
        const gasPrice = await provider.getFeeData();  
        const estimatedGas = 500000n; // Estimated gas for flash loan arbitrage  
        const gasCost = gasPrice.gasPrice * estimatedGas;  
        const maticBalance = await provider.getBalance(wallet.address);  
        
        console.log(`   ⛽ Gas Price: ${ethers.formatUnits(gasPrice.gasPrice, "gwei")} gwei`);  
        console.log(`   💰 Estimated Gas Cost: ${ethers.formatUnits(gasCost, 18)} MATIC`);  
        console.log(`   💳 Wallet Balance: ${ethers.formatUnits(maticBalance, 18)} MATIC`);  
        
        if (maticBalance < gasCost) {  
            console.error(`❌ Insufficient MATIC for gas. Need at least ${ethers.formatUnits(gasCost, 18)} MATIC`);  
            contractState.failedExecutions++;  
            return;  
        }  
        
        // Use executeBestFlashLoanArbitrage for optimal amount selection  
        const tx = await enforcerContract.executeBestFlashLoanArbitrage(  
            buyRouter,  
            sellRouter,  
            [amountInUSDC], // Use the specific profitable amount  
            pathToToken,  
            pathToUSDC,  
            deadline,  
            {  
                gasLimit: estimatedGas,  
                maxFeePerGas: gasPrice.maxFeePerGas,  
                maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas  
            }  
        );  
        
        console.log(`   📝 Transaction Submitted: ${tx.hash}`);  
        console.log(`   ⏳ Waiting for confirmation...`);  
        
        const receipt = await tx.wait();  
        
        console.log(`   ✅ Transaction Confirmed in Block ${receipt.blockNumber}`);  
        console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toString()}`);  
        
        return receipt;  
    } catch (err) {  
        console.error(`❌ Execution Failed:`, err.message);  
        contractState.failedExecutions++;  
        return null;  
    }  
}  

// ============================================================  
// BLOCK PROCESSING  
// ============================================================  
async function processBlock(blockNumber) {  
    contractState.totalAttempts++;  
    
    // Log progress periodically  
    if (contractState.totalAttempts % 100 === 0) {  
        const runtimeMinutes = ((Date.now() - contractState.startTime) / 1000 / 60).toFixed(1);  
        console.log(`📊 [Status] Block ${blockNumber} | Scanned: ${contractState.totalAttempts} blocks | Runtime: ${runtimeMinutes}m | Executions: ${contractState.successfulExecutions} | Profit: ${ethers.formatUnits(contractState.totalProfits, 6)} USDC`);  
    }  
    
    // Evaluate each router pair for arbitrage opportunities  
    for (const routerPair of ROUTER_PAIRS) {  
        const executed = await simulateAndExecute(routerPair, blockNumber);  
        if (executed) {  
            // Small delay to avoid non
