/** * ARBBOT1 - High-Velocity Production Execution & Diagnostic Engine  
 * Architecture: WSS Resilient Stream Pool -> Multi-Thread Worker Cluster -> Centralized Broadcast Queue  
 * Specification: Ethers v6 Production Build with Serialized Nonce Tracking & Mutex Lock  
 * Mode: ZERO-REVALIDATION RAW BATCH MATRIX EXECUTION  
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
    deadlineSeconds: 45,              
    minimumProfitThreshold: ethers.parseUnits("0.01", 6) // $0.01 USDC minimum profit  
};  

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
// MAIN ORCHESTRATION THREAD (Handles Synchronous Broadcast Queue & Nonces)  
// ============================================================================  
if (isMainThread) {  
    if (!process.env.PRIVATE_KEY) {  
        console.error("❌ Critical Error: PRIVATE_KEY environment variable is missing.");  
        process.exit(1);  
    }  

    console.log("🚀 PRODUCTION RUNNER STARTING: CONCURRENCY BOTTLE-NECK MITIGATION ENGINE");  
    
    const fastLaneRelayProvider = new ethers.JsonRpcProvider(CONFIG.fastLaneRpc, STATIC_POLYGON_NETWORK, { staticNetwork: true });  
    const executionWallet = new ethers.Wallet(process.env.PRIVATE_KEY, fastLaneRelayProvider);  
    const vaultInstance = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, executionWallet);  

    let totalRealizedProfits = 0n;  
    let workerThreads = [];  
    let mainProvider;  
    let currentEndpointIndex = 0;  
    let isRotating = false;  
    let fallbackTriggered = false;  
    let activeEngineName = "WebSocket Stream Cluster";  
    let blockWatchdogTimeout;  

    let nextAssignedNonce = -1;  
    let activeInFlightPayloads = 0;  

    let mutexLock = false;  
    let txQueue = [];  
    let isProcessingQueue = false;  

    async function acquireMutex() {  
        while (mutexLock) {  
            await new Promise(resolve => setTimeout(resolve, 1));  
        }  
        mutexLock = true;  
    }  

    function releaseMutex() {  
        mutexLock = false;  
        if (txQueue.length > 0 && !isProcessingQueue) {  
            const nextPayload = txQueue.shift();  
            processPayloadBroadcast(nextPayload);  
        }  
    }  

    const activeSubMatrices = [  
        { id: 1, routers: ["QUICK", "SUSHI"] },  
        { id: 2, routers: ["QUICK", "DFYN"] },  
        { id: 3, routers: ["SUSHI", "DFYN"] },  
        { id: 4, routers: ["QUICK", "SUSHI", "DFYN"] }  
    ];  

    async function validateProfitThreshold() {  
        try {  
            const onchainMinimum = await vaultInstance.minimumProfitUSDC();  
            if (onchainMinimum > CONFIG.minimumProfitThreshold) {  
                console.log(`⚡ Using on-chain minimum profit: ${ethers.formatUnits(onchainMinimum, 6)} USDC`);  
                return onchainMinimum;  
            }  
        } catch (err) {  
            console.log(`⚠️ Could not fetch on-chain minimum, using config threshold: ${err.message}`);  
        }  
        return CONFIG.minimumProfitThreshold;  
    }  

    async function processPayloadBroadcast(payload) {  
        await acquireMutex();  
        
        if (activeInFlightPayloads >= CONFIG.maxPendingTransactions) {  
            if (txQueue.length < 5) {  
                txQueue.push(payload);  
            }  
            releaseMutex();  
            return;   
        }  

        activeInFlightPayloads++;  
        isProcessingQueue = true;  
        
        try {  
            await validateProfitThreshold();  
            
            if (nextAssignedNonce === -1) {  
                nextAssignedNonce = await executionWallet.getNonce("pending");  
                console.log(`🔄 Initialized nonce: ${nextAssignedNonce}`);  
            }  

            const currentNonce = nextAssignedNonce;  
            nextAssignedNonce++;  

            const txDeadline = Math.floor(Date.now() / 1000) + CONFIG.deadlineSeconds;  
            
            console.log(`💼 Executing batch [Nonce #${currentNonce}] with ${payload.buyRouters.length} route pairs`);  
            
            const txResponse = await vaultInstance.executeRawBatchArbitrage(  
                payload.buyRouters,  
                payload.sellRouters,  
                CONFIG.candidateSizes.map(size => BigInt(size)),  
                payload.pathsToToken,  
                payload.pathsToUSDC,  
                txDeadline,  
                {  
                    gasLimit: CONFIG.gasLimitOverride,  
                    maxFeePerGas: payload.calculatedMaxFee,  
                    maxPriorityFeePerGas: payload.calculatedMaxPriority,  
                    nonce: currentNonce  
                }  
            );  

            console.log(`🚀 Bundle Broadcast Sent to Fastlane Relay [Nonce #${currentNonce}]: ${txResponse.hash}`);  

            const receipt = await txResponse.wait(CONFIG.blockConfirmConfirmations);  

            if (receipt.status === 1) {  
                console.log(`✨ BATCH EXECUTION SUCCESS! On-chain matrix execution finalized.`);  
                try {  
                    const profitLog = receipt.logs.find(log =>   
                        log.topics[0] === ethers.id("ArbitrageExecuted(uint256,uint256)")  
                    );  
                    if (profitLog) {  
                        const decodedProfit = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], profitLog.data)[0];  
                        totalRealizedProfits += decodedProfit;  
                        console.log(`💰 Realized Profit: +${ethers.formatUnits(decodedProfit, 6)} USDC`);  
                    }  
                } catch (logErr) {  
                    console.log(`⚠️ Could not parse profit from logs: ${logErr.message}`);  
                }  
                console.log(`💰 Cumulative Realized Capture: +${ethers.formatUnits(totalRealizedProfits, 6)} USDC`);  
            } else {  
                console.log(`🔴 On-chain Transaction Reverted: ${txResponse.hash}`);  
            }  

        } catch (err) {  
            const errMsg = err.message || "";  
            
            // Critical Fix: Only clear nonce if it is explicitly an underpricing or explicit expiration mismatch
            if (errMsg.includes("nonce too low") || errMsg.includes("already known")) {  
                console.log(`🔄 Nonce synchronization alignment triggered, clearing tracker cache`);  
                nextAssignedNonce = -1;   
            } else if (errMsg.includes("in-flight transaction limit") || err.code === -32000) {  
                // Dynamic strategy: If mempool queue limit hit, preserve current tracking nonce state but drop the structural subqueue to break loop congestion
                console.log(`⏳ Mempool full / Node limit reached. Purging queue backlog (${txQueue.length} dropped) to prioritize next upcoming blocks.`);  
                txQueue = [];  
                // Rollback local tracker index by 1 so the next block takes over the exact execution slot cleanly
                if (nextAssignedNonce > 0) nextAssignedNonce--;  
            }  
            
            console.log(`⚠️ Broadcast Exception or Skip [Main Broadcast Engine]: ${errMsg.substring(0, 120)}...`);  
        } finally {  
            activeInFlightPayloads--;  
            isProcessingQueue = false;  
            releaseMutex();  
        }  
    }  

    const totalWorkers = activeSubMatrices.length;  
    for (let i = 0; i < totalWorkers; i++) {  
        const engineWorker = new Worker(__filename, {  
            workerData: { workerId: activeSubMatrices[i].id, config: CONFIG, matrix: activeSubMatrices[i].routers }  
        });  

        engineWorker.on("message", (msg) => {  
            if (msg.type === "LOG") {  
                console.log(msg.data);  
            } else if (msg.type === "EXECUTE_BATCH") {  
                processPayloadBroadcast(msg.payload);  
            }  
        });  
        workerThreads.push(engineWorker);  
    }  

    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL`);  
    console.log(`└── Active Shard Subprocesses ● ${totalWorkers} Isolated Cluster Worker Threads`);  
    console.log(`└── Router Matrix: [QUICK/SUSHI], [QUICK/DFYN], [SUSHI/DFYN], [QUICK/SUSHI/DFYN]\n`);  

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

            mainProvider = new ethers.WebSocketProvider(targetEndpoint, STATIC_POLYGON_NETWORK, { staticNetwork: true });  
             
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
            console.log(`⚠️ WebSocket connection failed: ${initError.message}`);  
            await attemptFallbackRotation();  
        }  
    }  

    async function attemptFallbackRotation() {  
        if (isRotating || fallbackTriggered) return;  
        isRotating = true;  
        console.log(`🔄 Rotating WebSocket endpoint [${currentEndpointIndex} -> ${currentEndpointIndex + 1}]`);  
        currentEndpointIndex++;  
        if (currentEndpointIndex >= CONFIG.providerWssEndpoints.length) {  
            console.log(`⚠️ All WebSocket endpoints exhausted, switching to HTTP fallback`);  
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
        console.log(`🔧 Switching to HTTP Polling Fallback Mode`);  
        const fallbackProvider = new ethers.JsonRpcProvider(CONFIG.fallbackRpc, STATIC_POLYGON_NETWORK, { staticNetwork: true });  
        let lastBlockChecked = -1;  
        
        setInterval(async () => {  
            try {  
                const currentBlock = await fallbackProvider.getBlockNumber();  
                if (lastBlockChecked === -1) {  
                    lastBlockChecked = currentBlock - 1;  
                }  
                if (currentBlock > lastBlockChecked) {  
                    for (let i = lastBlockChecked + 1; i <= currentBlock; i++) {  
                        console.log(`\n[${activeEngineName}] 🔍 Scanning Block #${i} Across Shards...`);  
                        workerThreads.forEach((worker) => {  
                            worker.postMessage({ type: "BLOCK_TRIGGER", blockNumber: i });  
                        });  
                    }  
                    lastBlockChecked = currentBlock;  
                }  
            } catch (err) {  
                console.log(`⚠️ HTTP Fallback poll error: ${err.message}`);  
            }  
        }, 1500);  
    }  

    setTimeout(() => {   
        console.log(`📡 Initializing WebSocket connection...`);  
        connectWebSocketStream();   
    }, 300);  

    process.on('SIGINT', async () => {  
        console.log('\n🛑 Graceful shutdown initiated...');  
        clearTimeout(blockWatchdogTimeout);  
        workerThreads.forEach(worker => worker.terminate());  
        if (mainProvider) {  
            try {  
                mainProvider.removeAllListeners();  
                await mainProvider.destroy();  
            } catch (_) {}  
        }  
        process.exit(0);  
    });  

// ============================================================================  
// COMPONENT WORKER THREAD RUNTREES (Calculates parameters asynchronously)  
// ============================================================================  
} else {  
    const { workerId, config, matrix } = workerData;  
    const fastLaneRelayProvider = new ethers.JsonRpcProvider(config.fastLaneRpc, STATIC_POLYGON_NETWORK, { staticNetwork: true });  
    
    const cachedAddresses = {  
        usdcAddress: ethers.getAddress(config.usdcAddress.toLowerCase()),  
        coreAssets: [  
            ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"), // WMATIC  
            ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F"), // USDT  
            ethers.getAddress("0x8f3cf6ad23cd3ead9147012c493cea23a8919657"), // DAI  
            ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619")  // WETH  
        ]  
    };  

    parentPort.on("message", async (message) => {  
        if (message.type === "BLOCK_TRIGGER") {  
            const blockNumber = message.blockNumber;  
            
            parentPort.postMessage({  
                type: "LOG",  
                data: `✅ [Shard #${workerId}] Scanning Block #${blockNumber} | Matrix: [${matrix.join(", ")}]`  
            });  

            let calculatedMaxFee;  
            let calculatedMaxPriority;  

            try {  
                const feeDataPromise = fastLaneRelayProvider.getFeeData();  
                const timeoutPromise = new Promise((_, reject) =>   
                    setTimeout(() => reject(new Error("Fee data fetch timeout")), 4000)  
                );  
                
                const feeData = await Promise.race([feeDataPromise, timeoutPromise]);  
                const currentBaseFee = feeData.estimatedBaseFee || 0n;  
                calculatedMaxPriority = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");  
                calculatedMaxFee = (currentBaseFee * 2n) + calculatedMaxPriority;  

            } catch (err) {  
                const fallbackBaseFee = ethers.parseUnits("180", "gwei");  
                calculatedMaxPriority = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");  
                calculatedMaxFee = (fallbackBaseFee * 2n) + calculatedMaxPriority;  

                parentPort.postMessage({  
                    type: "LOG",  
                    data: `🚨 [Shard #${workerId}] Gas Fetch Stalled. Activating Hardcoded Safe-Limits (${ethers.formatUnits(calculatedMaxFee, "gwei")} Gwei)`  
                });  
            }  

            const routeSet = new Set();  
            const buyRouters = [];  
            const sellRouters = [];  
            const pathsToToken = [];  
            const pathsToUSDC = [];  

            for (let b = 0; b < matrix.length; b++) {  
                for (let s = 0; s < matrix.length; s++) {  
                    if (b === s) continue;  

                    const buyRouterAddress = config.routers[matrix[b]];  
                    const sellRouterAddress = config.routers[matrix[s]];  
                    if (!buyRouterAddress || !sellRouterAddress) continue;  

                    for (const intermediateAsset of cachedAddresses.coreAssets) {  
                        if (intermediateAsset.toLowerCase() === cachedAddresses.usdcAddress.toLowerCase()) continue;  

                        const routeKey = `${buyRouterAddress}-${sellRouterAddress}-${intermediateAsset}`;  
                        if (routeSet.has(routeKey)) continue;  
                        routeSet.add(routeKey);  

                        buyRouters.push(buyRouterAddress);  
                        sellRouters.push(sellRouterAddress);  
                        pathsToToken.push([cachedAddresses.usdcAddress, intermediateAsset]);  
                        pathsToUSDC.push([intermediateAsset, cachedAddresses.usdcAddress]);  
                    }  
                }  
            }  

            if (buyRouters.length === 0) {  
                return;  
            }  

            parentPort.postMessage({  
                type: "EXECUTE_BATCH",  
                payload: {  
                    buyRouters,  
                    sellRouters,  
                    pathsToToken,  
                    pathsToUSDC,  
                    calculatedMaxFee,  
                    calculatedMaxPriority,  
                    workerId,  
                    blockNumber,  
                    routesCount: buyRouters.length  
                }  
            });  
        }  
    });  

    parentPort.postMessage({  
        type: "LOG",  
        data: `🧵 [Shard #${workerId}] Worker initialized and ready | Matrix: [${matrix.join(", ")}]`  
    });  
}  

export { CONFIG, CONTRACT_ABI, STATIC_POLYGON_NETWORK };
