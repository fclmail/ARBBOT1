import { ethers } from "ethers";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { fileURLToPath } from "url";

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
    maxPendingTransactions: 1,
    rpcTimeout: 5000,
    pollInterval: 1500,
    fallbackProfitUSDC: "0.01",
    maxStuckNonceRetries: 3,
    executionRpc: "https://polygon.drpc.org", // Dedicated execution endpoint
    executionInterval: 3                      // Structural block gating step
};

const CONTRACT_ABI = [
    "function executeArbitrage(address[] paths, uint256 amountIn, uint256 minProfit) external returns (uint256 profit)",
    "function minimumProfitUSDC() external view returns (uint256)",
    "event ArbitrageExecuted(address indexed executor, uint256 profitInUSDC)"
];

// ============================================================================
// MAIN THREAD EXECUTION ENGINE
// ============================================================================
if (isMainThread) {
    const __filename = fileURLToPath(import.meta.url);
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL: PRIVATE_KEY environment variable is missing!");
        process.exit(1);
    }

    // 🔄 FIX: Swapped broken endpoint with active, public WebSocket routers for Bor
    const WS_ENDPOINTS = [
        "wss://polygon-bor-rpc.publicnode.com",
        "wss://polygon.gateway.tenderly.co",
        "wss://rpc-mainnet.maticvigil.com/ws/v1/rpc",
        "wss://ws-mainnet.polygon.network"
    ];
    const HTTP_ENDPOINT = "https://polygon-rpc.com";

    // Engine State
    let currentWsIndex = 0;
    let provider = null;
    let wallet = null;
    let executionContract = null;
    let activeInFlightPayloads = 0;
    let nextAssignedNonce = -1;
    let totalRealizedProfits = 0.0;
    let watchdogTimer = null;
    let currentBlockNumber = 0;

    // Mutex & Queue State
    let mutexLock = false;
    const txQueue = [];

    // Contract Mapping Structures
    const CONTRACT_ADDRESS = "0x1111111254fb6c44bac0bed2854e76f90643097d"; 
    const ROUTERS = {
        QUICK: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
        SUSHI: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        DFYN: "0xC10Ac1de48b9C43393a61F0f107f9038d17208fA"
    };

    // Dedicated Isolation Isolation Infrastructure Setup
    const executionProvider = new ethers.JsonRpcProvider(CONFIG.executionRpc, undefined, { staticNetwork: true });
    const executionWalletV2 = new ethers.Wallet(process.env.PRIVATE_KEY, executionProvider);

    console.log("⚙️ ARBBOT1 Engine Initializing...");

    async function acquireMutex() {
        while (mutexLock) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        mutexLock = true;
    }

    function releaseMutex() {
        mutexLock = false;
        if (txQueue.length > 0 && activeInFlightPayloads < CONFIG.maxPendingTransactions) {
            const nextPayload = txQueue.shift();
            processPayloadBroadcast(nextPayload);
        }
    }

    // Force Nonce Synchronizer
    async function resetNonceToLatest() {
        try {
            const pendingNonce = await executionWalletV2.getNonce("pending");
            const latestNonce = await executionWalletV2.getNonce("latest");
            
            console.log(`📊 Nonce Status - Pending: ${pendingNonce}, Latest: ${latestNonce}`);
            
            if (pendingNonce !== latestNonce) {
                console.log(`⚠️ ${pendingNonce - latestNonce} pending transaction(s) detected in the mempool`);
            }
            
            if (nextAssignedNonce < pendingNonce) {
                console.log(`🔄 FORCE ADVANCING nonce: ${nextAssignedNonce} → ${pendingNonce}`);
                nextAssignedNonce = pendingNonce;
            } else {
                nextAssignedNonce = pendingNonce;
            }
            return pendingNonce;
        } catch (err) {
            console.error(`⚠️ Nonce reset error: ${err.message}`);
            return -1;
        }
    }

    async function initConnection() {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        
        if (currentWsIndex < WS_ENDPOINTS.length) {
            const wsUrl = WS_ENDPOINTS[currentWsIndex];
            console.log(`📡 Connecting to WS Pool Endpoint [${currentWsIndex}]: ${wsUrl}`);
            try {
                provider = new ethers.WebSocketProvider(wsUrl, undefined, { staticNetwork: true });
                
                // 🛡️ CRITICAL FIX: Explicitly handle immediate socket connection errors 
                // to prevent unhandled asynchronous events from crashing Node.js
                if (provider.websocket) {
                    provider.websocket.onerror = (err) => {
                        console.warn(`⚠️ WebSocket socket-level error captured: ${err.message || 'Connection refused'}`);
                    };
                }

                currentBlockNumber = await provider.getBlockNumber();
                setupWsListeners();
                await initializeExecutionStack();
            } catch (err) {
                console.warn(`⚠️ WS Endpoint [${currentWsIndex}] failed initialization. Rotating...`);
                currentWsIndex++;
                await initConnection();
            }
        } else {
            console.error("🚨 All WS Pool streams exhausted! Activating HTTP Fallback Engine...");
            initHttpFallback();
        }
    }

    function setupWsListeners() {
        if (provider.websocket) {
            provider.websocket.onclose = () => {
                console.warn("⚠️ WebSocket disconnected. Triggering failover rotation...");
                currentWsIndex++;
                initConnection();
            };
        }
        
        provider.on("block", (blockNumber) => {
            currentBlockNumber = blockNumber;
            resetWatchdog();
        });
    }

    function resetWatchdog() {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => {
            console.warn("⏳ Watchdog Alert: 6s block timeout reached. Forcing endpoint rotation...");
            currentWsIndex++;
            initConnection();
        }, 6000);
    }

    function initHttpFallback() {
        provider = new ethers.JsonRpcProvider(HTTP_ENDPOINT, undefined, { staticNetwork: true });
        initializeExecutionStack();
        
        let lastBlock = -1;
        setInterval(async () => {
            try {
                const currentBlock = await provider.getBlockNumber();
                currentBlockNumber = currentBlock;
                if (lastBlock !== -1 && currentBlock > lastBlock + 1) {
                    console.warn(`📊 Block Gap Detected: Skipped from ${lastBlock} to ${currentBlock}`);
                }
                lastBlock = currentBlock;
            } catch (err) {
                console.error("❌ HTTP Fallback Engine connection error:", err.message);
            }
        }, CONFIG.pollInterval);
    }

    async function initializeExecutionStack() {
        wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        executionContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, executionWalletV2);
        await resetNonceToLatest();
        console.log(`🟩 Execution Stack live via Dedicated RPC. Base Nonce Tracked: [${nextAssignedNonce}]`);
    }

    async function robustSendTransaction(txOptions, retries = CONFIG.maxStuckNonceRetries) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const txData = await executionContract.executeArbitrage.populateTransaction(
                    txOptions.paths,
                    txOptions.amountIn,
                    txOptions.minProfit
                );

                const finalTx = {
                    ...txData,
                    nonce: txOptions.nonce,
                    maxFeePerGas: txOptions.maxFeePerGas,
                    maxPriorityFeePerGas: txOptions.maxPriorityFeePerGas,
                    gasLimit: txOptions.gasLimit,
                    to: CONTRACT_ADDRESS
                };

                const response = await executionWalletV2.sendTransaction(finalTx);
                console.log(`✅ TX Sent: Nonce #${txOptions.nonce} | Hash: ${response.hash.substring(0, 18)}...`);
                return response;
            } catch (err) {
                const errMsg = err.message.toLowerCase();
                if (errMsg.includes("-32000") || errMsg.includes("in-flight") || errMsg.includes("limit reached") || errMsg.includes("nonce too low")) {
                    console.log(`⚠️ Mempool / Limit conflict on attempt ${attempt}/${retries}: ${err.message}`);
                    
                    if (attempt === retries) {
                        console.log(`🔴 RESETTING NONCE SYSTEM - stuck on assignment #${txOptions.nonce}`);
                        await resetNonceToLatest();
                        
                        console.log(`⏳ Waiting 12 seconds for remote node mempool pipeline clearance...`);
                        await new Promise(resolve => setTimeout(resolve, 12000));
                        
                        const newNonce = await executionWalletV2.getNonce("pending");
                        console.log(`🔄 New nonce resolved after pipeline wait: ${newNonce}`);
                        
                        txOptions.nonce = newNonce;
                        nextAssignedNonce = newNonce + 1;
                        
                        const freshFeeData = await provider.getFeeData();
                        txOptions.maxFeePerGas = freshFeeData.maxFeePerGas ? (freshFeeData.maxFeePerGas * 130n) / 100n : undefined;
                        txOptions.maxPriorityFeePerGas = freshFeeData.maxPriorityFeePerGas ? (freshFeeData.maxPriorityFeePerGas * 130n) / 100n : undefined;

                        return await robustSendTransaction(txOptions, 1);
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } else {
                    throw err;
                }
            }
        }
    }

    async function processPayloadBroadcast(payload) {
        if (currentBlockNumber % CONFIG.executionInterval !== 0) {
            return; 
        }

        await acquireMutex();

        if (activeInFlightPayloads >= CONFIG.maxPendingTransactions) {
            txQueue.push(payload);
            releaseMutex();
            console.log(`📥 Inflight limit reached (${activeInFlightPayloads}). Payload pushed to TxQueue (Depth: ${txQueue.length})`);
            return;
        }

        activeInFlightPayloads++;

        try {
            if (nextAssignedNonce === -1) {
                await resetNonceToLatest();
            }

            const currentNonce = nextAssignedNonce;
            nextAssignedNonce++;
            
            releaseMutex();

            let minProfit;
            try {
                minProfit = await executionContract.minimumProfitUSDC({ timeout: CONFIG.rpcTimeout });
            } catch {
                minProfit = ethers.parseUnits(CONFIG.fallbackProfitUSDC, 6);
            }

            console.log(`🚀 Dispatching Tx Engine Matrix | Nonce: ${currentNonce} | Routes: [${payload.paths.join(" -> ")}]`);

            const feeData = await provider.getFeeData();
            const premiumMaxFeePerGas = feeData.maxFeePerGas ? (feeData.maxFeePerGas * 125n) / 100n : undefined;
            const premiumMaxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * 125n) / 100n : undefined;

            const txOptions = {
                paths: payload.paths,
                amountIn: payload.amountIn,
                minProfit: minProfit,
                nonce: currentNonce,
                maxFeePerGas: premiumMaxFeePerGas,
                maxPriorityFeePerGas: premiumMaxPriorityFeePerGas,
                gasLimit: 350000
            };

            const txResponse = await robustSendTransaction(txOptions);
            const receipt = await txResponse.wait();
            
            const iface = new ethers.Interface(CONTRACT_ABI);
            receipt.logs.forEach((log) => {
                try {
                    const parsedLog = iface.parseLog(log);
                    if (parsedLog.name === "ArbitrageExecuted") {
                        const profitRaw = parsedLog.args.profitInUSDC;
                        const profit = parseFloat(ethers.formatUnits(profitRaw, 6));
                        totalRealizedProfits += profit;
                        console.log(`✨ Success! Realized Profit: +${profit} USDC | Cumulative: ${totalRealizedProfits.toFixed(6)} USDC`);
                    }
                } catch { /* Not our target event */ }
            });

        } catch (err) {
            console.error(`❌ Complete Functional Failure for Execution Nonce Assumed:`, err.message);
            nextAssignedNonce = -1;
        } finally {
            activeInFlightPayloads--;
            if (mutexLock) releaseMutex();
        }
    }

    const SHARD_MATRICES = [
        [ROUTERS.QUICK, ROUTERS.SUSHI],                  
        [ROUTERS.QUICK, ROUTERS.DFYN],                    
        [ROUTERS.SUSHI, ROUTERS.DFYN],                    
        [ROUTERS.QUICK, ROUTERS.SUSHI, ROUTERS.DFYN]     
    ];

    SHARD_MATRICES.forEach((matrix, index) => {
        const worker = new Worker(__filename, {
            workerData: { workerId: index + 1, matrix }
        });

        worker.on("message", (msg) => {
            if (msg.type === "EXECUTE_BATCH") {
                processPayloadBroadcast(msg.payload);
            } else if (msg.type === "LOG") {
                console.log(msg.data);
            }
        });

        worker.on("error", (err) => console.error(`🚨 Worker Shard ${index + 1} Error:`, err));
    });

    initConnection();

    process.on("SIGINT", () => {
        console.log("\n🛑 Gracefully shutting down Engine. Cleaning RPC pools...");
        if (provider && provider.destroy) provider.destroy();
        process.exit(0);
    });

} else {
    const { workerId, matrix } = workerData;

    parentPort.postMessage({
        type: "LOG",
        data: `🧵 [Shard #${workerId}] Worker initialized and ready | Matrix Allocation Count: [${matrix.length} Node Pairs]`
    });

    setInterval(() => {
        const opportunityDetected = Math.random() > 0.98; 

        if (opportunityDetected) {
            const executionPayload = {
                paths: matrix,
                amountIn: "1000000000000000000000" 
            };

            parentPort.postMessage({
                type: "EXECUTE_BATCH",
                payload: executionPayload
            });
        }
    }, 200);
}

export { CONFIG, CONTRACT_ABI };
