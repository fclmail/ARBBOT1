/**
 * ARBBOT1 - High-Velocity Production Execution & Diagnostic Engine
 * Architecture: WSS Resilient Stream Pool -> Multi-Thread Worker Cluster -> FastLane Bundle Relay
 * Specification: Ethers v6 Production Build
 * Mode: ZERO-REVALIDATION RAW BATCH MATRIX EXECUTION
 * Target: Smart Contract #2 (Hardcoded High-Liquidity Tokens Optimization)
 */
import { ethers } from "ethers";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// COMPREHENSIVE GLOBAL CONFIGURATION
// ============================================================================
const CONFIG = {
    providerWssEndpoints: [
        "wss://polygon-rpc.com/ws",
        "wss://polygon-bor-rpc.publicnode.com",
        "wss://rpc-mainnet.matterlight.xyz/ws",
        "wss://polygon.gateway.tenderly.co",
        "wss://polygon.rpc.subquery.network/public/ws"
    ],
    fastLaneRpc: "https://polygon-bor-rpc.publicnode.com",
    fallbackRpc: "https://polygon.drpc.org",
    contractAddress: ethers.getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc".toLowerCase()),
    usdcAddress: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()),
    gasLimitOverride: 850000n,
    priorityFeeGwei: 45n,
    candidateSizes: [
        "1000000",          // $1.00 USDC
        "10000000",         // $10.00 USDC
        "50000000",         // $50.00 USDC
        "100000000",        // $100.00 USDC
        "500000000",        // $500.00 USDC
        "1000000000"        // $1,000.00 USDC
    ],
    routers: {
        QUICK:   ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),
        SUSHI:   ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase()),
        DFYN:    ethers.getAddress("0xF15361A03Eca00a63A23e1bd165157Cb02434a62".toLowerCase())
    },
    maxPendingTransactions: 1,        
    blockConfirmConfirmations: 1,      
    deadlineSeconds: 45              
};

// Smart Contract #2 Updated Complete Minimal Application Binary Interface (ABI)
const CONTRACT_ABI = [
    "function executeRawBatchArbitrage(address[] calldata buyRouters, address[] calldata sellRouters, uint256[] calldata candidateSizes, address[][] calldata pathsToToken, address[][] calldata pathsToUSDC, uint256 deadline) external returns (uint256)",
    "function minimumProfitUSDC() external view returns (uint256)"
];

const STATIC_POLYGON_NETWORK = ethers.Network.from({ name: "polygon", chainId: 137 });

process.on("uncaughtException", (err) => {
    if (err.message && (err.message.includes("Unexpected server response") || err.message.includes("detect network") || err.message.includes("websocket"))) return;
    console.error("☠️ System Intercepted Exception:", err);
});

// ============================================================================
// MAIN ORCHESTRATION THREAD
// ============================================================================
if (isMainThread) {
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ Critical Error: PRIVATE_KEY environment variable is missing.");
        process.exit(1);
    }

    console.log("🚀 PRODUCTION RUNNER STARTING: CONFIG BALANCED FOR RAW BATCH MATRIX ARBITRAGE");  
    console.log(`📡 Target RPC Endpoint: ${CONFIG.fastLaneRpc}`);  
     
    let totalRealizedProfits = 0.0;  
    let workerThreads = [];  
    let mainProvider;  
    let currentEndpointIndex = 0;  
    let isRotating = false;  
    let fallbackTriggered = false;  
    let activeEngineName = "WebSocket Stream Cluster";  
    let blockWatchdogTimeout;

    // Streamlined allocation across 4 specialized sub-processing matrices
    const activeSubMatrices = [  
        { id: 1, routers: ["QUICK", "SUSHI", "DFYN"] },
        { id: 2, routers: ["QUICK", "SUSHI", "DFYN"] },
        { id: 3, routers: ["QUICK", "SUSHI", "DFYN"] },
        { id: 4, routers: ["QUICK", "SUSHI", "DFYN"] }
    ];  

    const totalWorkers = activeSubMatrices.length;  
     
    for (let i = 0; i < totalWorkers; i++) {
        const engineWorker = new Worker(__filename, {  
            workerData: { workerId: activeSubMatrices[i].id, config: CONFIG, matrix: activeSubMatrices[i].routers }  
        });  

        engineWorker.on("message", (msg) => {  
            if (msg.type === "LOG") {  
                console.log(msg.data);  
            } else if (msg.type === "PROFIT") {  
                totalRealizedProfits += msg.amount;  
                console.log(`💰 Combined Metric Realized Capture: +${totalRealizedProfits.toFixed(6)} USDC`);  
            }  
        });  
        workerThreads.push(engineWorker);  
    }  

    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL`);
    console.log(`└── Active Shard Subprocesses ● ${totalWorkers} Isolated Cluster Worker Threads\n`);

    function resetBlockWatchdog() {
        clearTimeout(blockWatchdogTimeout);
        if (fallbackTriggered) return;
        blockWatchdogTimeout = setTimeout(() => {
            attemptFallbackRotation();
        }, 6000);
    }

    async function connectWebSocketStream() {  
        if (fallbackTriggered) return;  
        const targetEndpoint = CONFIG.providerWssEndpoints[currentEndpointIndex];  
           
        try {  
            if (mainProvider) {  
                try {
                    mainProvider.removeAllListeners();
                    if (mainProvider.websocket) {
                        mainProvider.websocket.close();
                        mainProvider.websocket.terminate();
                    }
                    await mainProvider.destroy();
                } catch (_) {}  
            }  

            mainProvider = new ethers.WebSocketProvider(targetEndpoint, STATIC_POLYGON_NETWORK);
             
            if (mainProvider.websocket) {
                mainProvider.websocket.on("error", () => attemptFallbackRotation());
                mainProvider.websocket.on("close", () => attemptFallbackRotation());
            }
               
            isRotating = false;  
            resetBlockWatchdog();

            mainProvider.on("block", async (blockNumber) => {  
                if (fallbackTriggered) return;
                resetBlockWatchdog();
                console.log(`\n[${activeEngineName}] 🔍 Scanning Block #${blockNumber} Across Shards...`);
                workerThreads.forEach((worker) => {  
                    worker.postMessage({ type: "BLOCK_TRIGGER", blockNumber });  
                });  
            });  

        } catch (initError) {  
            await attemptFallbackRotation();  
        }  
    }  

    async function attemptFallbackRotation() {  
        if (isRotating || fallbackTriggered) return;  
        isRotating = true;  
        currentEndpointIndex++;  
        if (currentEndpointIndex >= CONFIG.providerWssEndpoints.length) {  
            fallbackTriggered = true;  
            setupHttpFallbackMode();  
            return;  
        }  
        isRotating = false;  
        await connectWebSocketStream();  
    }  

    function setupHttpFallbackMode() {  
        clearTimeout(blockWatchdogTimeout);
        if (mainProvider) {
            try { mainProvider.removeAllListeners(); mainProvider.destroy(); } catch (_) {}
        }
        activeEngineName = "HTTP Fallback Engine";  
        const fallbackProvider = new ethers.JsonRpcProvider(CONFIG.fallbackRpc, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });  
         
        fallbackProvider.on("block", (blockNumber) => {  
            console.log(`\n[${activeEngineName}] 🔍 Scanning Block #${blockNumber} Across Shards...`);
            workerThreads.forEach((worker) => {  
                worker.postMessage({ type: "BLOCK_TRIGGER", blockNumber });  
            });  
        });  
    }  

    setTimeout(() => { connectWebSocketStream(); }, 300);  

// ============================================================================
// COMPONENT WORKER THREAD RUNTREES
// ============================================================================
} else {
    const { workerId, config, matrix } = workerData;
    const fastLaneRelayProvider = new ethers.JsonRpcProvider(config.fastLaneRpc, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });  
    const executionWallet = new ethers.Wallet(process.env.PRIVATE_KEY, fastLaneRelayProvider);  
    const vaultInstance = new ethers.Contract(config.contractAddress, CONTRACT_ABI, executionWallet);  
     
    let pendingTransactionsCount = 0;

    parentPort.on("message", async (message) => {  
        if (message.type === "BLOCK_TRIGGER") {  
            if (pendingTransactionsCount >= config.maxPendingTransactions) return;

            // Diagnostic trace tracking local matrix targeting array parameters
            parentPort.postMessage({  
                type: "LOG",  
                data: `✅ [Shard #${workerId}] Scanning Matrix Array: [${matrix.join(", ")}] × Hardcoded Liquidity Assets`  
            });  

            try {  
                const feeData = await fastLaneRelayProvider.getFeeData();  
                const currentBaseFee = feeData.estimatedBaseFee || 0n;  
                const calculatedMaxPriority = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");  
                const calculatedMaxFee = (currentBaseFee * 2n) + calculatedMaxPriority;  

                const buyRouters = [];
                const sellRouters = [];
                const pathsToToken = [];
                const pathsToUSDC = [];

                // FIXED: Fully wrap all cross-asset tokens with getAddress to preserve EIP-55 compliance across shards
                const coreAssets = [
                    ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"), // WMATIC
                    ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F"), // USDT
                    ethers.getAddress("0x8f3cf6ad23cd3ead9147012c493cea23a8919657"), // DAI
                    ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619")  // WETH
                ];

                // Generate real cross-asset combinatorial matrix pipelines
                for (let b = 0; b < matrix.length; b++) {
                    for (let s = 0; s < matrix.length; s++) {
                        if (b === s) continue;

                        const buyRouterAddress = config.routers[matrix[b]];
                        const sellRouterAddress = config.routers[matrix[s]];
                        if (!buyRouterAddress || !sellRouterAddress) continue;

                        // Create specific paths across all available liquidity hubs
                        for (const intermediateAsset of coreAssets) {
                            if (intermediateAsset.toLowerCase() === config.usdcAddress.toLowerCase()) continue;

                            buyRouters.push(buyRouterAddress);
                            sellRouters.push(sellRouterAddress);

                            // Path A: From USDC to Target Bridge Token
                            pathsToToken.push([config.usdcAddress, intermediateAsset]);
                            // Path B: From Target Bridge Token back to USDC
                            pathsToUSDC.push([intermediateAsset, config.usdcAddress]);
                        }
                    }
                }

                if (buyRouters.length === 0) return;

                const txDeadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;  
                pendingTransactionsCount++;

                // Zero-Revalidation Raw Batch Pipeline Call sent directly on-chain
                const txResponse = await vaultInstance.executeRawBatchArbitrage(  
                    buyRouters,  
                    sellRouters,  
                    config.candidateSizes.map(size => BigInt(size)),  
                    pathsToToken,  
                    pathsToUSDC,  
                    txDeadline,  
                    {  
                        gasLimit: config.gasLimitOverride,  
                        maxFeePerGas: calculatedMaxFee,  
                        maxPriorityFeePerGas: calculatedMaxPriority
                    }
                );

                parentPort.postMessage({  
                    type: "LOG",  
                    data: `🚀 Bundle Broadcast Sent to Fastlane Relay: ${txResponse.hash}`  
                });  

                const receipt = await txResponse.wait(config.blockConfirmConfirmations);  
                pendingTransactionsCount--;

                if (receipt.status === 1) {  
                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `✨ BATCH EXECUTION SUCCESS! On-chain matrix execution finalized.`  
                    });  
                    
                    parentPort.postMessage({ type: "PROFIT", amount: 0.0 });  
                } else {  
                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `🔴 On-chain Transaction Reverted: ${txResponse.hash}`  
                    });  
                }  

            } catch (err) {  
                pendingTransactionsCount--;  
                parentPort.postMessage({  
                    type: "LOG",  
                    data: `⚠️ Broadcast Exception or Skip [Shard #${workerId}]: ${err.message}`  
                });  
            }  
        }  
    });  
}
