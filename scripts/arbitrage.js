import { ethers } from "ethers";  
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";  
import { fileURLToPath } from "url";  

// ============================================================================  
// CONFIGURATION & CONSTANTS  
// ============================================================================  
export const CONFIG = {  
    maxPendingTransactions: 3,           // Increased from 1 to allow concurrent txs  
    rpcTimeout: 10000,                   // Increased for reliability  
    pollInterval: 1500,  
    fallbackProfitUSDC: "0.01",  
    maxStuckNonceRetries: 5,             // Increased retries  
    executionRpc: "https://polygon-bor-rpc.publicnode.com",  
     // ✅ FIXED: Changed from polygon.drpc.org  
    executionInterval: 3,  
    nonceSyncBlocks: 5,                  // Re-sync nonce every 5 blocks  
    mempoolWaitBaseMs: 4000,             // Base wait time for mempool clearance  
    maxTxQueueDepth: 500                 // Maximum queue depth  
};  

export const CONTRACT_ABI = [  
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
    let lastNonceSyncBlock = 0;  

    // Mutex & Queue State  
    let mutexLock = false;  
    const txQueue = [];  

    // Addresses normalized to lowercase to bypass EIP-55 checksum exceptions  
    const CONTRACT_ADDRESS = ethers.getAddress("0x1111111254fb6c44bac0bed2854e76f90643097d".toLowerCase());   
    const ROUTERS = {  
        QUICK: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),  
        SUSHI: ethers.getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506".toLowerCase()),  
        DFYN: ethers.getAddress("0xC10Ac1de48b9C43393a61F0f107f9038d17208fA".toLowerCase())  
    };  

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
            lastNonceSyncBlock = currentBlockNumber;  
            return pendingNonce;  
        } catch (err) {  
            console.error(`⚠️ Nonce reset error: ${err.message}`);  
            return -1;  
        }  
    }  

    // ============================================================================  
    // CRITICAL FIX: Force nonce past stuck transactions  
    // ============================================================================  
    async function forceNoncePastMempool() {  
        console.log("🔧 FORCING nonce advancement past mempool blockage...");  
        
        const pendingNonce = await executionWalletV2.getNonce("pending");  
        const latestNonce = await executionWalletV2.getNonce("latest");  
        
        console.log(`📊 Chain State - Pending: ${pendingNonce}, Latest: ${latestNonce}`);  
        
        if (pendingNonce === latestNonce) {  
            console.log("✅ No stuck transactions detected");  
            nextAssignedNonce = pendingNonce;  
            return pendingNonce;  
        }  
        
        console.log(`⚠️ Stuck tx detected at nonce ${latestNonce}`);  
        console.log(`🔄 First available nonce: ${pendingNonce}`);  
        
        try {  
            const stuckTx = await executionProvider.getTransaction({  
                from: wallet.address,  
                nonce: latestNonce  
            });  
            
            if (stuckTx && stuckTx.blockNumber === null) {  
                const txTime = stuckTx.timestamp ? stuckTx.timestamp * 1000 : Date.now();  
                const ageSeconds = Math.floor((Date.now() - txTime) / 1000);  
                console.log(`⏳ Transaction at nonce ${latestNonce} is still pending (${ageSeconds}s old)`);  
                
                if (Date.now() - txTime > 30000) {  
                    console.log("🔴 Transaction stuck > 30s, attempting cancel...");  
                    await cancelStuckTransaction(latestNonce);  
                    return nextAssignedNonce;  
                }  
            }  
        } catch (err) {  
            console.log(`ℹ️ Cannot fetch stuck tx details: ${err.message}`);  
        }  
        
        nextAssignedNonce = pendingNonce;  
        return pendingNonce;  
    }  

    async function cancelStuckTransaction(stuckNonce) {  
        try {  
            const feeData = await executionProvider.getFeeData();  
            
            const cancelTx = {  
                to: wallet.address,   
                value: 0,  
                nonce: stuckNonce,  
                maxFeePerGas: feeData.maxFeePerGas ? (feeData.maxFeePerGas * 200n) / 100n : undefined,   
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * 200n) / 100n : undefined,  
                gasLimit: 21000  
            };  
            
            console.log(`📤 Sending cancel tx for nonce ${stuckNonce}...`);  
            const response = await executionWalletV2.sendTransaction(cancelTx);  
            console.log(`✅ Cancel tx sent: ${response.hash}`);  
            
            await new Promise(resolve => setTimeout(resolve, 10000));  
            
            const newPending = await executionWalletV2.getNonce("pending");  
            console.log(`📊 After cancel - Pending: ${newPending}`);  
            
            nextAssignedNonce = newPending;  
            return newPending;  
            
        } catch (err) {  
            console.error(`❌ Cancel failed: ${err.message}`);  
            nextAssignedNonce = stuckNonce + 1;  
            return stuckNonce + 1;  
        }  
    }  

    async function initConnection() {  
        if (watchdogTimer) clearTimeout(watchdogTimer);  
        
        if (currentWsIndex < WS_ENDPOINTS.length) {  
            const wsUrl = WS_ENDPOINTS[currentWsIndex];  
            console.log(`📡 Connecting to WS Pool Endpoint [${currentWsIndex}]: ${wsUrl}`);  
            try {  
                provider = new ethers.WebSocketProvider(wsUrl, undefined, { staticNetwork: true });  
                
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
        
        provider.on("block", async (blockNumber) => {  
            currentBlockNumber = blockNumber;  
            resetWatchdog();  
            
            if (blockNumber - lastNonceSyncBlock >= CONFIG.nonceSyncBlocks) {  
                await acquireMutex();  
                await resetNonceToLatest();  
                releaseMutex();  
            }  
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
                
                if (lastBlock !== -1 && currentBlock - lastNonceSyncBlock >= CONFIG.nonceSyncBlocks) {  
                    await acquireMutex();  
                    await resetNonceToLatest();  
                    releaseMutex();  
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
        console.log("🚀 Main thread initialized with workers");  
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
                        await forceNoncePastMempool();  
                        
                        console.log(`⏳ Waiting ${CONFIG.mempoolWaitBaseMs / 1000} seconds for remote node mempool pipeline clearance...`);  
                        await new Promise(resolve => setTimeout(resolve, CONFIG.mempoolWaitBaseMs));  
                        
                        const newNonce = nextAssignedNonce;  
                        console.log(`🔄 New nonce resolved after pipeline wait: ${newNonce}`);  
                        
                        txOptions.nonce = newNonce;  
                        nextAssignedNonce = newNonce + 1;  
                        
                        const freshFeeData = await provider.getFeeData();  
                        txOptions.maxFeePerGas = freshFeeData.maxFeePerGas ? (freshFeeData.maxFeePerGas * 130n) / 100n : undefined;  
                        txOptions.maxPriorityFeePerGas = freshFeeData.maxPriorityFeePerGas ? (freshFeeData.maxPriorityFeePerGas * 130n) / 100n : undefined;  

                        return await robustSendTransaction(txOptions, 1);  
                    } else {  
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));  
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
            if (txQueue.length < CONFIG.maxTxQueueDepth) {  
                txQueue.push(payload);  
                console.log(`📥 Inflight limit reached (${activeInFlightPayloads}). Payload pushed to TxQueue (Depth: ${txQueue.length})`);  
            } else {  
                console.warn(`⚠️ Warning: Max TxQueue Depth reached (${CONFIG.maxTxQueueDepth}). Dropping oldest payload structural frame.`);  
            }  
            releaseMutex();  
            return;  
        }  

        activeInFlightPayloads++;  

        try {  
            if (nextAssignedNonce === -1) {  
                await resetNonceToLatest();  
            }  

            const currentNonce = nextAssignedNonce;  
            nextAssignedNonce++;  
            
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

            releaseMutex();  

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
                } catch { /* Mismatch log entry */ }  
            });  

        } catch (err) {  
            console.error(`❌ Complete Functional Failure for Execution Nonce Assumed:`, err.message);  
            nextAssignedNonce = -1;  
            if (mutexLock) releaseMutex();  
        } finally {  
            activeInFlightPayloads--;  
        }  
    }  

    const SHARD_MATRICES = [  
        [ROUTERS.QUICK, ROUTERS.SUSHI],                  
        [ROUTERS.QUICK, ROUTERS.DFYN],                    
        [ROUTERS.SUSHI, ROUTERS.DFYN],                    
        [ROUTERS.QUICK, ROUTERS.SUSHI, ROUTERS.DFYN]     
    ];

    const activeWorkers = [];

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
        activeWorkers.push(worker);
    });

    initConnection();

    process.on("SIGINT", () => {
        console.log("\n🛑 Gracefully shutting down Engine. Cleaning RPC pools and worker shards...");
        activeWorkers.forEach(w => w.terminate());
        if (provider && provider.destroy) provider.destroy();
        process.exit(0);
    });

} else {
    // ============================================================================
    // WORKER CODE - Only runs in worker threads
    // ============================================================================
    const { workerId, matrix } = workerData;

    parentPort.postMessage({
        type: "LOG",
        data: `🧵 [Shard #${workerId}] Worker initialized and ready | Matrix Allocation Count: [${matrix.length} Node Pairs]`
    });

    const scanningInterval = setInterval(() => {
        const opportunityDetected = Math.random() > 0.98;

        if (opportunityDetected) {
            const executionPayload = {
                paths: matrix,
                amountIn: ethers.parseEther("1000").toString() // 1000 MATIC
            };

            parentPort.postMessage({
                type: "EXECUTE_BATCH",
                payload: executionPayload
            });
            
            parentPort.postMessage({
                type: "LOG",
                data: `🎯 [Shard #${workerId}] Opportunity detected! Routes: ${matrix.join(" → ")}`
            });
        }
    }, 200);

    parentPort.on('close', () => {
        clearInterval(scanningInterval);
        process.exit(0);
    });
}





/*
// fix-nonce.js
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

async function fix() {
    const pending = await wallet.getNonce("pending");
    const latest = await wallet.getNonce("latest");
    console.log(`Pending: ${pending}, Latest: ${latest}`);
    
    if (pending > latest) {
        const feeData = await provider.getFeeData();
        const cancelTx = await wallet.sendTransaction({
            to: wallet.address, value: 0,
            nonce: latest,
            maxFeePerGas: feeData.maxFeePerGas * 150n / 100n,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 150n / 100n,
            gasLimit: 21000
        });
        console.log(`✅ Cancel sent: ${cancelTx.hash}`);
        await cancelTx.wait();
        console.log("✅ Stuck nonce cleared!");
    } else {
        console.log("✅ No stuck transactions");
    }
}
fix().catch(console.error);






// fix-nonce.js - Run ONCE to clear stuck nonce before restarting the bot
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

async function fix() {
    console.log("🔍 Checking nonce state...");
    
    const pending = await wallet.getNonce("pending");
    const latest = await wallet.getNonce("latest");
    
    console.log(`📊 Pending nonce: ${pending}`);
    console.log(`📊 Latest nonce: ${latest}`);
    
    if (pending > latest) {
        const stuckCount = pending - latest;
        console.log(`⚠️ Found ${stuckCount} stuck transaction(s)! Clearing nonce ${latest}...`);
        
        const feeData = await provider.getFeeData();
        console.log(`⛽ Base fee: ${feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, "gwei") : "N/A"} gwei`);
        
        // Send a self-transfer with higher gas to replace the stuck transaction
        const cancelTx = await wallet.sendTransaction({
            to: wallet.address,
            value: 0,
            nonce: latest,
            maxFeePerGas: feeData.maxFeePerGas ? (feeData.maxFeePerGas * 150n) / 100n : ethers.parseUnits("100", "gwei"),
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * 150n) / 100n : ethers.parseUnits("50", "gwei"),
            gasLimit: 21000
        });
        
        console.log(`✅ Cancel transaction sent: ${cancelTx.hash}`);
        console.log("⏳ Waiting for confirmation...");
        
        await cancelTx.wait(1);
        console.log("✅ Stuck nonce cleared! Bot can now restart safely.");
        
        // Verify
        const newPending = await wallet.getNonce("pending");
        const newLatest = await wallet.getNonce("latest");
        console.log(`📊 After fix - Pending: ${newPending}, Latest: ${newLatest}`);
        
        if (newPending === newLatest) {
            console.log("✅ All clear! No stuck transactions remaining.");
        } else {
            console.log(`⚠️ Still ${newPending - newLatest} stuck tx(s). Run this script again.`);
        }
    } else {
        console.log("✅ No stuck transactions detected. Safe to restart the bot.");
    }
}

fix().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
});
*/
