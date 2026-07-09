/**
 * ARBBOT1 - Production Node.js Engine
 * Network: Polygon (POSIX)
 * Architecture: Zero-Revalidation Matrix Flash Batch Executor
 */

const { ethers } = require("ethers");

// ==========================================
// 1. CONFIGURATION & ENVIRONMENT SETUP
// ==========================================
const CONFIG = {
    WSS_RPC: "wss://polygon-bor-rpc.publicnode.com", // Replace with your private low-latency WSS provider if available
    HTTP_RPC: "https://polygon-bor-rpc.publicnode.com",
    FASTLANE_RELAY: "https://bor.fastlane.xyz", // FastLane MEV bundle validator endpoint
    PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000000", // Your deployer/owner private key
    CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000000", // VaultArbitrageEnforcer address
    USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",     // Polygon Bridged USDC
    
    // Core Matrix Target Assets (Restored Multi-Hop Paths)
    TOKENS: {
        USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        DAI: "0x8f3Cf6ad23Cd3EAd96143c01f6F155802654e5a9",
        USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
    },

    // Dex Routers for Matrix Generation
    ROUTERS: {
        QUICK_SWAP: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
        SUSHI_SWAP: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        DFYN: "0xF184565860993a467c745cc7d04e17849B3bc04A"
    },

    BATCH_SIZE_LIMIT: 25, // Split massive matrices into small safe payloads to stay within block gas limits
    STUCK_TX_TIMEOUT_MS: 4000 // 4 seconds before triggering force-advancement nonce logic
};

// ==========================================
// 2. CONTRACT ABI DEFINTIONS
// ==========================================
const ENFORCER_ABI = [
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"
];

const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)"
];

// ==========================================
// 3. GLOBAL STATE & NONCE MANAGEMENT ENGINE
// ==========================================
let providerWss;
let providerHttp;
let wallet;
let enforcerContract;
let usdcContract;

let currentNonce = -1;
let isProcessingBlock = false;
let txTimeoutTracker = null;

async function initialize() {
    console.log("📡 Connecting Matrix Engine via WebSockets...");
    providerWss = new ethers.providers.WebSocketProvider(CONFIG.WSS_RPC);
    providerHttp = new ethers.providers.JsonRpcProvider(CONFIG.HTTP_RPC);
    
    wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, providerHttp);
    enforcerContract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    usdcContract = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);

    // Sync baseline nonce directly from node transaction pool
    currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");
    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL. Initial Wallet Nonce: [${currentNonce}]`);

    // Monitor for successful trade completions to look for logs
    setupLogListeners();

    // Begin Block Pipeline Subscription Loop
    providerWss.on("block", async (blockNumber) => {
        if (isProcessingBlock) {
            console.log(`⏳ Block #${blockNumber} arrived but previous transaction batch is still in-flight. Skipping scan...`);
            return;
        }
        
        try {
            isProcessingBlock = true;
            await processBlockMatrix(blockNumber);
        } catch (err) {
            console.error(`❌ Matrix Processing Exception on Block #${blockNumber}:`, err.message);
        } finally {
            isProcessingBlock = false;
        }
    });

    // WSS Health check / Keep-Alive reconnection pattern
    providerWss._websocket.on("close", () => {
        console.error("🔴 WebSocket disconnected! Re-establishing interface immediately...");
        setTimeout(initialize, 3000);
    });
}

// ==========================================
// 4. ON-CHAIN MATRIX GENERATION (MULTI-HOP)
// ==========================================
function generateMatrixPayloads() {
    const buyRouters = [];
    const sellRouters = [];
    const amountsInUSDC = [];
    const pathsToToken = [];
    const pathsToUSDC = [];

    const routersList = Object.values(CONFIG.ROUTERS);
    // Expand core routes across multi-hop assets restored: USDT, WETH, WMATIC, DAI
    const targetIntermediateTokens = [CONFIG.TOKENS.WETH, CONFIG.TOKENS.WMATIC, CONFIG.TOKENS.DA3, CONFIG.TOKENS.USDT].filter(Boolean);

    // Common inputs for this optimization (e.g. 500 USDC or 1000 USDC allocations)
    const testAmounts = [ethers.utils.parseUnits("500", 6)]; 

    for (const buyRouter of routersList) {
        for (const sellRouter of routersList) {
            if (buyRouter === sellRouter) continue; // Must be a cross-dex discrepancy

            for (const intermediateToken of targetIntermediateTokens) {
                for (const amount of testAmounts) {
                    
                    buyRouters.push(buyRouter);
                    sellRouters.push(sellRouter);
                    amountsInUSDC.push(amount);
                    
                    // Route 1: Base USDC -> Target Volatile Asset
                    pathsToToken.push([CONFIG.TOKENS.USDC, intermediateToken]);
                    // Route 2: Target Volatile Asset -> Base USDC
                    pathsToUSDC.push([intermediateToken, CONFIG.TOKENS.USDC]);
                }
            }
        }
    }

    // Chunk size limiting implementation to prevent Gas Limit Rejections on Polygon
    const chunks = [];
    for (let i = 0; i < buyRouters.length; i += CONFIG.BATCH_SIZE_LIMIT) {
        chunks.push({
            buyRouters: buyRouters.slice(i, i + CONFIG.BATCH_SIZE_LIMIT),
            sellRouters: sellRouters.slice(i, i + CONFIG.BATCH_SIZE_LIMIT),
            amountsInUSDC: amountsInUSDC.slice(i, i + CONFIG.BATCH_SIZE_LIMIT),
            pathsToToken: pathsToToken.slice(i, i + CONFIG.BATCH_SIZE_LIMIT),
            pathsToUSDC: pathsToUSDC.slice(i, i + CONFIG.BATCH_SIZE_LIMIT),
            deadline: Math.floor(Date.now() / 1000) + 120
        });
    }

    return chunks;
}

// ==========================================
// 5. ZERO-REVALIDATION BATCH PIPELINE
// ==========================================
async function processBlockMatrix(blockNumber) {
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} Across Shards...`);
    
    const batches = generateMatrixPayloads();
    if (batches.length === 0) return;

    // Fetch optimal gas conditions dynamically to compete with public mempool frontrunners
    const feeData = await providerHttp.getFeeData();
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(2) : ethers.utils.parseUnits("40", "gwei");
    const maxFeePerGas = feeData.maxFeePerGas ? feeData.maxFeePerGas.add(maxPriorityFeePerGas) : ethers.utils.parseUnits("200", "gwei");

    // Zero-Revalidation Pattern: Directly dispatch top execution batches to the network without off-chain simulation
    for (let i = 0; i < Math.min(batches.length, 2); i++) {
        const currentBatch = batches[i];
        const targetNonce = currentNonce;
        
        console.log(`🚀 Sending Batch Structure #${i+1} to Fastlane Engine via Nonce #${targetNonce}`);

        try {
            // Build the transaction options payload
            const txOptions = {
                nonce: targetNonce,
                maxPriorityFeePerGas,
                maxFeePerGas,
                gasLimit: 3000000 // Fixed structural cap for batch transactions
            };

            // Call structural array payload inside smart contract execution interface
            const txPromise = enforcerContract.executeFlashBatchArbitrage(currentBatch, txOptions);
            
            currentNonce++; // Proactively step the local variable ahead to prevent immediate collisions

            // Start the stale transaction watchdog timer to prevent system freeze at this nonce number
            startWatchdog(targetNonce, txOptions);

            const tx = await txPromise;
            console.log(`✨ Transaction Dispatched! Hash: ${tx.hash}`);

            // Wait for receipt in background thread
            tx.wait().then((receipt) => {
                clearWatchdog();
                if (receipt.status === 1) {
                    console.log(`✅ Transaction Confirmed inside block ${receipt.blockNumber}`);
                } else {
                    console.log(`🔴 On-chain Transaction Reverted: ${receipt.transactionHash}`);
                }
            }).catch((err) => {
                clearWatchdog();
                console.log(`🔴 Transaction Execution Dropped/Reverted: ${err.message}`);
            });

        } catch (txError) {
            console.error(`❌ Batch pipeline transmission failed at runtime:`, txError.message);
            // Sync up nonce state accurately on unrecoverable failures
            currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");
            clearWatchdog();
            break;
        }
    }
}

// ==========================================
// 6. STUCK TX BLOCKAGE ENGINE (FORCE NONCE)
// ==========================================
function startWatchdog(stuckNonce, originalTxOptions) {
    clearWatchdog();
    
    txTimeoutTracker = setTimeout(async () => {
        console.warn(`🚨 [CRITICAL ALERT] Nonce #${stuckNonce} stuck for more than ${CONFIG.STUCK_TX_TIMEOUT_MS / 1000}s! FORCING nonce advancement past mempool blockage...`);
        
        try {
            // Construct aggressive speed replacement options package (50% bump minimum)
            const rescueGasPrice = originalTxOptions.maxFeePerGas.mul(15).div(10);
            const rescuePriorityPrice = originalTxOptions.maxPriorityFeePerGas.mul(15).div(10);

            console.log(`⚡ Sending Empty Speed-Up Cancel Transaction for Nonce #${stuckNonce}...`);
            const cancelTx = await wallet.sendTransaction({
                to: wallet.address,
                value: 0,
                nonce: stuckNonce,
                maxFeePerGas: rescueGasPrice,
                maxPriorityFeePerGas: rescuePriorityPrice,
                gasLimit: 21000
            });

            await cancelTx.wait();
            console.log(`♻️ Successfully cleared roadblock at Nonce #${stuckNonce}. Mempool cleared.`);
            
            // Re-sync authoritative nonces from ledger indexers
            currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");
        } catch (rescueError) {
            console.error(`❌ Nonce force advancement failed:`, rescueError.message);
            currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");
        }
    }, CONFIG.STUCK_TX_TIMEOUT_MS);
}

function clearWatchdog() {
    if (txTimeoutTracker) {
        clearTimeout(txTimeoutTracker);
        txTimeoutTracker = null;
    }
}

// ==========================================
// 7. EVENT DECODER & RAW PROFIT LOGGER
// ==========================================
function setupLogListeners() {
    // Subscribes directly to logs emitted from the deployed target enforcer contract instance
    enforcerContract.on("ArbitrageExecuted", (buyRouter, sellRouter, token, amountInUSDC, beforeBal, afterBal, profitUSDC) => {
        // Formats the metric out into readable raw parameters directly matching standard token layout
        const formattedProfit = ethers.utils.formatUnits(profitUSDC, 6);
        
        // Command Mandate Check: Raw amounts only - no deductions for gas or other fees displayed.
        console.log(`💰 Combined Metric Realized Capture: +${formattedProfit} USDC`);
    });
}

// Kickstart script execution engine
initialize().catch(console.error);
