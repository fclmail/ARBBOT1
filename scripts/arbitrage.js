/**
 * ARBBOT1 - COMPLETE FIXED VERSION
 * * Fixes applied:
 * 1. Rate limiting with cooldown between blocks
 * 2. Proper profit tracking from contract
 * 3. Balance monitoring and verification
 * 4. Error handling for rate limits and failed transactions
 * 5. Automatic retry with backoff
 */
import { Wallet, Contract, JsonRpcProvider, WebSocketProvider, parseUnits, formatUnits, getAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const CONFIG = {
    // RPC Endpoints
    WSS_RPC: process.env.WSS_RPC || "wss://polygon-bor-rpc.publicnode.com",
    HTTP_RPC: process.env.HTTP_RPC || "https://polygon-bor-rpc.publicnode.com",
    
    // Wallet
    PRIVATE_KEY: process.env.PRIVATE_KEY || "",
    
    // Contracts
    CONTRACT_ADDRESS: getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc"),
    USDC_ADDRESS: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),
    
    // Tokens
    WETH: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"),
    
    // Routers
    QUICK_SWAP: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
    SUSHI_SWAP: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"),
    
    // Strategy Parameters
    CANDIDATE_SIZES: [
        parseUnits("100", 6),   // 100 USDC
        parseUnits("500", 6),   // 500 USDC
        parseUnits("1000", 6),  // 1000 USDC
        parseUnits("2500", 6),  // 2500 USDC
        parseUnits("5000", 6),  // 5000 USDC
    ],
    
    MIN_PROFIT_THRESHOLD: parseUnits("0.01", 6), // $0.01 minimum profit
    
    // Rate Limiting
    BLOCK_COOLDOWN: 2,         // Wait 2 blocks between attempts
    MAX_PENDING_TXS: 2,        // Maximum pending transactions
    TX_TIMEOUT: 60000,         // 60 seconds transaction timeout
    
    // Gas Settings
    GAS_LIMIT: 800000,
    MAX_PRIORITY_FEE: parseUnits("50", 9), // 50 Gwei
    MAX_FEE: parseUnits("200", 9),         // 200 Gwei
    
    // Monitoring
    BALANCE_CHECK_INTERVAL: 10000, // 10 seconds
};

// Contract ABIs
const ENFORCER_ABI = [
    // Core functions
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",
    
    // View functions
    "function owner() external view returns (address)",
    "function vault() external view returns (address)",
    "function minimumProfitUSDC() external view returns (uint256)",
    "function totalProfitsAccumulated() external view returns (uint256)",
    "function getContractBalance() external view returns (uint256)",
    "function getTotalProfits() external view returns (uint256)",
    "function usdc() external view returns (address)",
    "function aavePool() external view returns (address)",
    
    // Events
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, uint256 amountIn, uint256 amountOut, uint256 profit, uint256 timestamp)",
    "event FlashLoanExecuted(address indexed token, uint256 amount, uint256 fee, uint256 profit, uint256 timestamp)",
    "event TradeExecuted(string indexed label, address indexed router, uint256 amountIn, uint256 amountOut, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)",
    "event ProfitsWithdrawn(address indexed to, uint256 amount)",
    
    // Owner functions
    "function withdraw(uint256 amount) external",
    "function withdrawProfits(uint256 amount) external",
    "function setVault(address _newVault) external",
    "function setRetainProfits(bool _retain) external"
];

const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)"
];

// State management
let wallet;
let enforcerContract;
let usdcContract;
let providerHttp;
let providerWss;

let contractState = {
    lastBalance: BigInt(0),
    totalProfits: BigInt(0),
    lastBlockAttempted: 0,
    pendingTxCount: 0,
    consecutiveFailures: 0,
    lastSuccessTimestamp: 0,
    isInitialized: false
};

// Performance metrics
const metrics = {
    totalAttempts: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalProfit: BigInt(0),
    startTime: Date.now()
};

/**
 * Initialize the bot with all connections
 */
async function initialize() {
    console.log("=".repeat(60));
    console.log("ðŸš€ ARBBOT1 - FLASH LOAN ARBITRAGE BOT");
    console.log("=".repeat(60));
    
    // Validate configuration
    if (!CONFIG.PRIVATE_KEY) {
        throw new Error("âŒ PRIVATE_KEY not set in environment variables");
    }
    
    try {
        // Initialize providers
        providerHttp = new JsonRpcProvider(CONFIG.HTTP_RPC);
        providerWss = new WebSocketProvider(CONFIG.WSS_RPC);
        
        // Initialize wallet
        wallet = new Wallet(CONFIG.PRIVATE_KEY, providerHttp);
        
        console.log(`ðŸ‘¤ Bot Wallet: ${wallet.address}`);
        
        // Initialize contracts
        enforcerContract = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
        usdcContract = new Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);
        
        // Verify contract ownership
        const contractOwner = await enforcerContract.owner();
        console.log(`ðŸ“‹ Contract Owner: ${contractOwner}`);
        
        if (contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {
            console.warn("âš ï¸  Warning: Bot wallet is not the contract owner!");
            console.warn("   Some functions may not work correctly.");
        }
        
        // Check contract configuration
        const minProfit = await enforcerContract.minimumProfitUSDC();
        const vault = await enforcerContract.vault();
        const usdcAddress = await enforcerContract.usdc();
        
        console.log(`ðŸ’µ Minimum Profit: ${formatUnits(minProfit, 6)} USDC`);
        console.log(`ðŸ¦ Vault Address: ${vault}`);
        console.log(`ðŸ’° USDC Token: ${usdcAddress}`);
        
        // Get USDC token info
        const usdcDecimals = await usdcContract.decimals();
        const usdcSymbol = await usdcContract.symbol();
        console.log(`ðŸ“Š USDC Decimals: ${usdcDecimals}, Symbol: ${usdcSymbol}`);
        
        // Get initial contract balance
        const initialBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
        contractState.lastBalance = initialBalance;
        
        // Get total profits accumulated
        const totalProfits = await enforcerContract.getTotalProfits();
        contractState.totalProfits = totalProfits;
        
        console.log(`\nðŸ’° Initial Contract USDC Balance: ${formatUnits(initialBalance, 6)}`);
        console.log(`ðŸ’° Total Profits Accumulated: ${formatUnits(totalProfits, 6)}`);
        
        contractState.isInitialized = true;
        console.log("\nâœ… Bot initialized successfully!");
        console.log(`ðŸŒ Connected to Polygon Network`);
        console.log(`â° Start Time: ${new Date().toLocaleString()}`);
        console.log("=".repeat(60));
        
        return true;
    } catch (error) {
        console.error("âŒ Initialization failed:", error.message);
        throw error;
    }
}

/**
 * Process each new block for arbitrage opportunities
 */
async function processBlock(blockNumber) {
    if (!contractState.isInitialized) {
        console.log("âš ï¸ Bot not initialized, skipping block");
        return;
    }

    // Rate limiting checks
    if (contractState.pendingTxCount >= CONFIG.MAX_PENDING_TXS) {
        console.log(`â³ Maximum pending transactions reached (${contractState.pendingTxCount}), waiting...`);
        return;
    }

    if (blockNumber - contractState.lastBlockAttempted < CONFIG.BLOCK_COOLDOWN) {
        return; // Skip - too soon since last attempt
    }

    console.log(`\n${"â”€".repeat(40)}`);
    console.log(`ðŸ” Scanning Block #${blockNumber}`);
    console.log(`${"â”€".repeat(40)}`);

    metrics.totalAttempts++;

    try {
        // Check current contract balance
        const balanceBefore = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
        console.log(`ðŸ’° Contract Balance: ${formatUnits(balanceBefore, 6)} USDC`);

        // Check total profits accumulated
        const totalProfits = await enforcerContract.getTotalProfits();
        console.log(`ðŸ“Š Total Profits: ${formatUnits(totalProfits, 6)} USDC`);

        // Update state
        contractState.lastBalance = balanceBefore;
        contractState.totalProfits = totalProfits;

        // Attempt arbitrage with best size
        console.log(`ðŸš€ Attempting flash loan arbitrage...`);
        console.log(`   Buy Router: ${CONFIG.QUICK_SWAP}`);
        console.log(`   Sell Router: ${CONFIG.SUSHI_SWAP}`);
        console.log(`   Path: USDC â†’ WETH â†’ USDC`);

        // Record attempt time
        const attemptStartTime = Date.now();
        contractState.lastBlockAttempted = blockNumber;

        // Prepare transaction
        const tx = await enforcerContract.executeBestFlashLoanArbitrage(
            CONFIG.QUICK_SWAP,
            CONFIG.SUSHI_SWAP,
            CONFIG.CANDIDATE_SIZES,
            [CONFIG.USDC_ADDRESS, CONFIG.WETH],
            [CONFIG.WETH, CONFIG.USDC_ADDRESS],
            Math.floor(Date.now() / 1000) + 120, // 2 minute deadline
            {
                gasLimit: CONFIG.GAS_LIMIT,
                maxPriorityFeePerGas: CONFIG.MAX_PRIORITY_FEE,
                maxFeePerGas: CONFIG.MAX_FEE
            }
        );

        contractState.pendingTxCount++;
        console.log(`âœ… Transaction sent: ${tx.hash}`);
        console.log(`â³ Pending transactions: ${contractState.pendingTxCount}`);

        // Wait for confirmation with timeout
        const receipt = await Promise.race([
            tx.wait(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Transaction timeout")), CONFIG.TX_TIMEOUT)
            )
        ]);

        contractState.pendingTxCount--;
        const executionTime = Date.now() - attemptStartTime;

        console.log(`âœ… Transaction confirmed in block ${receipt.blockNumber}`);
        console.log(`â±ï¸  Execution time: ${executionTime}ms`);
        console.log(`â›½ Gas used: ${receipt.gasUsed.toString()}`);

        // Check balance after execution
        const balanceAfter = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
        const totalProfitsAfter = await enforcerContract.getTotalProfits();

        // Calculate this trade's profit
        const thisTradeProfit = balanceAfter - balanceBefore;
        
        console.log(`\nðŸ“Š Post-Trade Analysis:`);
        console.log(`   Balance Before: ${formatUnits(balanceBefore, 6)} USDC`);
        console.log(`   Balance After: ${formatUnits(balanceAfter, 6)} USDC`);
        console.log(`   Trade Profit: ${formatUnits(thisTradeProfit, 6)} USDC`);
        console.log(`   Total Profits: ${formatUnits(totalProfitsAfter, 6)} USDC`);

        // Update metrics
        if (thisTradeProfit > 0) {
            metrics.successfulTrades++;
            metrics.totalProfit += thisTradeProfit;
            contractState.lastSuccessTimestamp = Date.now();
            contractState.consecutiveFailures = 0;
            
            console.log(`\nðŸŽ‰ PROFITABLE TRADE!`);
            console.log(`   Profit: ${formatUnits(thisTradeProfit, 6)} USDC`);
            
            // Alert if significant profit
            if (thisTradeProfit > parseUnits("10", 6)) {
                console.log(`ðŸ”” Significant profit detected!`);
                // Optionally integrate with Discord/Telegram API
                // await sendAlert(`ðŸ’¸ Profit of ${formatUnits(thisTradeProfit, 6)} USDC detected!`);
            }
        } else {
            metrics.failedTrades++;
            contractState.consecutiveFailures++;
            console.log(`âŒ Trade completed but no profit detected`);
        }

        // Update state
        contractState.lastBalance = balanceAfter;
        contractState.totalProfits = totalProfitsAfter;

        // Display performance metrics
        const elapsedHours = (Date.now() - metrics.startTime) / 3600000;
        console.log(`\nðŸ“ˆ Performance Metrics:`);
        console.log(`   Attempts: ${metrics.totalAttempts}`);
        console.log(`   Successful: ${metrics.successfulTrades}`);
        console.log(`   Failed: ${metrics.failedTrades}`);
        console.log(`   Success Rate: ${metrics.totalAttempts > 0 ? 
            ((metrics.successfulTrades / metrics.totalAttempts) * 100).toFixed(1) : 0}%`);
        console.log(`   Total Profit: ${formatUnits(metrics.totalProfit, 6)} USDC`);
        console.log(`   Runtime: ${elapsedHours.toFixed(1)} hours`);
        console.log(`   Avg Profit/Trade: ${metrics.successfulTrades > 0 ? 
            formatUnits(metrics.totalProfit / BigInt(metrics.successfulTrades), 6) : 0} USDC`);

        // Automatic pause on too many failures
        if (contractState.consecutiveFailures >= 10) {
            console.log(`\nâš ï¸ Too many consecutive failures (${contractState.consecutiveFailures})`);
            console.log(`â¸ï¸  Pausing for ${Math.min(contractState.consecutiveFailures * 10, 120)} seconds...`);
            await new Promise(resolve => setTimeout(resolve, Math.min(contractState.consecutiveFailures * 10000, 120000)));
            contractState.consecutiveFailures = 0;
        }
    } catch (error) {
        contractState.pendingTxCount = Math.max(0, contractState.pendingTxCount - 1);
        contractState.consecutiveFailures++;
        metrics.failedTrades++;

        console.log(`âŒ Error processing block ${blockNumber}:`);

        // Handle specific error types
        if (error.message.includes("Flash loan unprofitable")) {
            console.log(`   âš ï¸  Flash loan arbitrage was not profitable enough`);
        } else if (error.message.includes("No profitable size")) {
            console.log(`   âš ï¸  No candidate size was profitable`);
        } else if (error.message.includes("profit below minimum")) {
            console.log(`   âš ï¸  Profit below minimum threshold`);
        } else if (error.code === "CALL_EXCEPTION") {
            console.log(`   âš ï¸  Contract execution reverted (likely no opportunity)`);
        } else if (error.code === "INSUFFICIENT_FUNDS") {
            console.log(`   âŒ Insufficient funds for gas!`);
        } else if (error.code === "ACTION_REJECTED") {
            console.log(`   âŒ Transaction rejected by wallet`);
        } else if (error.message.includes("Transaction timeout")) {
            console.log(`   âš ï¸  Transaction timed out`);
        } else {
            console.log(`   âŒ ${error.message}`);
        }

        console.log(`   Consecutive failures: ${contractState.consecutiveFailures}`);
        
        // Display performance metrics
        const elapsedHours = (Date.now() - metrics.startTime) / 3600000;
        console.log(`\nðŸ“ˆ Performance Metrics (After Error):`);
        console.log(`   Attempts: ${metrics.totalAttempts}`);
        console.log(`   Successful: ${metrics.successfulTrades}`);
        console.log(`   Failed: ${metrics.failedTrades}`);
        console.log(`   Success Rate: ${metrics.totalAttempts > 0 ? 
            ((metrics.successfulTrades / metrics.totalAttempts) * 100).toFixed(1) : 0}%`);
        console.log(`   Runtime: ${elapsedHours.toFixed(1)} hours`);
        console.log(`   Consecutive Failures: ${contractState.consecutiveFailures}`);
    }
}

/**
 * Balance monitoring and profit withdrawal
 */
async function monitorAndWithdraw() {
    try {
        const balance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
        const totalProfits = await enforcerContract.getTotalProfits();
        
        console.log(`\n${"â”€".repeat(40)}`);
        console.log(`ðŸ’¼ Balance Monitoring`);
        console.log(`${"â”€".repeat(40)}`);
        console.log(`Contract USDC Balance: ${formatUnits(balance, 6)}`);
        console.log(`Total Profits: ${formatUnits(totalProfits, 6)}`);

        // Update state
        contractState.lastBalance = balance;
        contractState.totalProfits = totalProfits;

        // Check if we should withdraw profits
        // Withdraw if profits exceed 100 USDC
        if (totalProfits > parseUnits("100", 6)) {
            console.log(`ðŸ¤‘ Profits accumulated: ${formatUnits(totalProfits, 6)} USDC`);
            console.log(`ðŸ“¤ Attempting profit withdrawal...`);
            
            try {
                // Withdraw 90% of profits, leave some for gas
                const withdrawAmount = totalProfits * BigInt(90) / BigInt(100);
                
                const tx = await enforcerContract.withdrawProfits(withdrawAmount, {
                    gasLimit: 200000,
                    maxPriorityFeePerGas: CONFIG.MAX_PRIORITY_FEE,
                    maxFeePerGas: CONFIG.MAX_FEE
                });
                
                const receipt = await tx.wait();
                console.log(`âœ… Withdrawal successful! TX: ${receipt.hash}`);
                console.log(`ðŸ’¸ Withdrawn: ${formatUnits(withdrawAmount, 6)} USDC`);
                
                // Update metrics
                metrics.totalProfit -= withdrawAmount; // Reset counter
                
            } catch (withdrawError) {
                console.error(`âŒ Withdrawal failed: ${withdrawError.message}`);
            }
        }
    } catch (error) {
        console.error(`âŒ Balance monitoring error: ${error.message}`);
    }
}

/**
 * Main loop - listens to new blocks
 */
async function startListening() {
    console.log(`\nðŸ“¡ Starting block listener on Polygon...`);
    console.log(`â³ Listening for new blocks...\n`);

    // Start balance monitoring interval
    setInterval(monitorAndWithdraw, CONFIG.BALANCE_CHECK_INTERVAL);

    try {
        // Listen for new blocks via WebSocket
        providerWss.on("block", async (blockNumber) => {
            console.log(`\nðŸ”µ New Block: #${blockNumber} | ${new Date().toLocaleTimeString()}`);
            
            // Process the block
            await processBlock(blockNumber);
            
            // Log current state
            console.log(`\nðŸ“Š Current State:`);
            console.log(`   Pending TXs: ${contractState.pendingTxCount}`);
            console.log(`   Last Block Attempted: ${contractState.lastBlockAttempted}`);
            console.log(`   Consecutive Failures: ${contractState.consecutiveFailures}`);
        });

        // Handle WebSocket errors and reconnect
        providerWss.on("error", async (error) => {
            console.error(`\nâŒ WebSocket Error: ${error.message}`);
            console.log(`ðŸ”„ Attempting reconnection in 5 seconds...`);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Reconnect
            try {
                providerWss = new WebSocketProvider(CONFIG.WSS_RPC);
                console.log(`âœ… Reconnected to WebSocket`);
                startListening(); // Restart listener
            } catch (reconnectError) {
                console.error(`âŒ Reconnection failed: ${reconnectError.message}`);
                process.exit(1);
            }
        });

        // Handle WebSocket close
        providerWss.on("close", async () => {
            console.log(`\nðŸ”Œ WebSocket connection closed`);
            console.log(`ðŸ”„ Attempting reconnection in 5 seconds...`);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            try {
                providerWss = new WebSocketProvider(CONFIG.WSS_RPC);
                console.log(`âœ… Reconnected to WebSocket`);
                startListening();
            } catch (reconnectError) {
                console.error(`âŒ Reconnection failed: ${reconnectError.message}`);
                process.exit(1);
            }
        });
    } catch (error) {
        console.error(`âŒ Fatal error in main loop: ${error.message}`);
        process.exit(1);
    }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`ðŸ›‘ Shutting down bot...`);
    console.log(`${"=".repeat(60)}`);
    
    // Display final metrics
    const elapsedHours = (Date.now() - metrics.startTime) / 3600000;
    console.log(`\nðŸ“Š Final Performance Summary:`);
    console.log(`   Runtime: ${elapsedHours.toFixed(1)} hours`);
    console.log(`   Total Attempts: ${metrics.totalAttempts}`);
    console.log(`   Successful Trades: ${metrics.successfulTrades}`);
    console.log(`   Failed Trades: ${metrics.failedTrades}`);
    console.log(`   Success Rate: ${metrics.totalAttempts > 0 ? 
        ((metrics.successfulTrades / metrics.totalAttempts) * 100).toFixed(1) : 0}%`);
    console.log(`   Total Profit: ${formatUnits(metrics.totalProfit, 6)} USDC`);
    console.log(`   Avg Profit/Trade: ${metrics.successfulTrades > 0 ? 
        formatUnits(metrics.totalProfit / BigInt(metrics.successfulTrades), 6) : 0} USDC`);
    
    try {
        // Close WebSocket connection
        if (providerWss) {
            providerWss.removeAllListeners();
            await providerWss.destroy();
            console.log(`âœ… WebSocket connection closed`);
        }
    } catch (error) {
        console.error(`âš ï¸ Error during shutdown: ${error.message}`);
    }
    
    console.log(`\nðŸ‘‹ Bot shutdown complete.`);
    process.exit(0);
}

/**
 * Health check endpoint for monitoring
 */
async function healthCheck() {
    try {
        const blockNumber = await providerHttp.getBlockNumber();
        const balance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
        const totalProfits = await enforcerContract.getTotalProfits();
        
        return {
            status: "healthy",
            timestamp: new Date().toISOString(),
            blockNumber: blockNumber,
            contractBalance: formatUnits(balance, 6),
            totalProfits: formatUnits(totalProfits, 6),
            pendingTransactions: contractState.pendingTxCount,
            uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
            metrics: {
                totalAttempts: metrics.totalAttempts,
                successfulTrades: metrics.successfulTrades,
                failedTrades: metrics.failedTrades,
                totalProfit: formatUnits(metrics.totalProfit, 6)
            }
        };
    } catch (error) {
        return {
            status: "unhealthy",
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

/**
 * Main execution function
 */
async function main() {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`ðŸš€ ARBBOT1 - FLASH LOAN ARBITRAGE SYSTEM`);
    console.log(`ðŸŒ Network: Polygon Mainnet`);
    console.log(`ðŸ“… Started: ${new Date().toLocaleString()}`);
    console.log(`${"=".repeat(60)}`);

    // Handle process signals
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("uncaughtException", async (error) => {
        console.error(`\nâŒ Uncaught Exception: ${error.message}`);
        console.error(error.stack);
        await shutdown();
    });
    process.on("unhandledRejection", async (reason, promise) => {
        console.error(`\nâŒ Unhandled Promise Rejection at:`, promise);
        console.error(`   Reason: ${reason}`);
        await shutdown();
    });

    try {
        // Initialize bot
        await initialize();
        
        // Print configuration summary
        console.log(`\nðŸ“‹ Configuration Summary:`);
        console.log(`   Contract: ${CONFIG.CONTRACT_ADDRESS}`);
        console.log(`   QuickSwap: ${CONFIG.QUICK_SWAP}`);
        console.log(`   SushiSwap: ${CONFIG.SUSHI_SWAP}`);
        console.log(`   Block Cooldown: ${CONFIG.BLOCK_COOLDOWN} blocks`);
        console.log(`   Max Pending TXs: ${CONFIG.MAX_PENDING_TXS}`);
        console.log(`   TX Timeout: ${CONFIG.TX_TIMEOUT / 1000}s`);
        console.log(`   Gas Limit: ${CONFIG.GAS_LIMIT}`);
        console.log(`   Max Priority Fee: ${formatUnits(CONFIG.MAX_PRIORITY_FEE, 9)} Gwei`);
        console.log(`   Max Fee: ${formatUnits(CONFIG.MAX_FEE, 9)} Gwei`);
        console.log(`   Min Profit: ${formatUnits(CONFIG.MIN_PROFIT_THRESHOLD, 6)} USDC`);
        console.log(`   Balance Check Interval: ${CONFIG.BALANCE_CHECK_INTERVAL / 1000}s`);
        
        // Start listening for blocks
        await startListening();
        
    } catch (error) {
        console.error(`\nâŒ Fatal Error: ${error.message}`);
        console.error(error.stack);
        await shutdown();
    }
}

// Run the bot
main().catch(async (error) => {
    console.error(`\nðŸ’¥ Fatal Error: ${error.message}`);
    console.error(error.stack);
    await shutdown();
});
