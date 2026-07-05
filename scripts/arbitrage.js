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
};

const STATIC_POLYGON_NETWORK = {
    name: "polygon",
    chainId: 137,
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
    
    // Validate Environment
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL: PRIVATE_KEY environment variable is missing!");
        process.exit(1);
    }

    // RPC Endpoints (WS Pool & HTTP Fallback)
    const WS_ENDPOINTS = [
        "wss://polygon-mainnet.g.allifca.com/v3/rpc",
        "wss://polygon.gateway.tenderly.co",
        "wss://rpc-mainnet.maticvigil.com/ws/v1/rpc",
        "wss://ws-mainnet.polygon.network",
        "wss://polygon.rpc.blxrbdn.com"
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

    // Mutex & Queue State
    let mutexLock = false;
    const txQueue = [];

    // Contract Addresses (Hardcoded matrix anchors)
    const CONTRACT_ADDRESS = "0x1111111254fb6c44bac0bed2854e76f90643097d"; // Target Execution Contract
    const ROUTERS = {
        QUICK: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
        SUSHI: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        DFYN: "0xC10Ac1de48b9C43393a61F0f107f9038d17208fA"
    };

    console.log("⚙️ ARBBOT1 Engine Initializing...");

    // Atomic Mutex Functions
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

    // Initialize Provider Connection
    async function initConnection() {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        
        if (currentWsIndex < WS_ENDPOINTS.length) {
            const wsUrl = WS_ENDPOINTS[currentWsIndex];
            console.log(`📡 Connecting to WS Pool Endpoint [${currentWsIndex}]: ${wsUrl}`);
            try {
                provider = new ethers.providers.WebSocketProvider(wsUrl, STATIC_POLYGON_NETWORK);
                await provider.getBlockNumber(); // Test connection
                setupWsListeners();
                initializeExecutionStack();
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
        provider._websocket.on("close", () => {
            console.warn("⚠️ WebSocket disconnected. Triggering failover rotation...");
            currentWsIndex++;
            initConnection();
        });
        
        provider.on("block", (blockNumber) => {
            resetWatchdog();
            // Broadcast new block triggering condition to shards if needed
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
        provider = new ethers.providers.JsonRpcProvider(HTTP_ENDPOINT, STATIC_POLYGON_NETWORK);
        initializeExecutionStack();
        
        // Interval block checking loop
        let lastBlock = -1;
        setInterval(async () => {
            try {
                const currentBlock = await provider.getBlockNumber();
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
        executionContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
        try {
            nextAssignedNonce = await wallet.getNonce("pending");
            console.log(`🟩 Execution Stack live. Base Nonce Tracked: [${nextAssignedNonce}]`);
        } catch (err) {
            console.error("❌ Failed to resolve initial network nonce:", err.message);
        }
    }

    // High-Velocity Serialized Execution Router
    async function processPayloadBroadcast(payload) {
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
                nextAssignedNonce = await wallet.getNonce("pending");
            }

            const currentNonce = nextAssignedNonce;
            nextAssignedNonce++;
            
            // Release mutex early now that the structural critical section variables are updated safely
            releaseMutex();

            // 💰 Profit Validation Check
            let minProfit;
            try {
                minProfit = await executionContract.minimumProfitUSDC({ timeout: CONFIG.rpcTimeout });
            } catch {
                minProfit = ethers.utils.parseUnits(CONFIG.fallbackProfitUSDC, 6); // Fallback to 0.01 USDC
            }

            console.log(`🚀 Dispatching Tx | Nonce: ${currentNonce} | Routes: [${payload.paths.join(" -> ")}] | MinProfit req: ${ethers.utils.formatUnits(minProfit, 6)} USDC`);

            // Gas price Strategy configuration
            const feeData = await provider.getFeeData();
            
            const tx = await executionContract.executeArbitrage(
                payload.paths,
                payload.amountIn,
                minProfit,
                {
                    nonce: currentNonce,
                    maxFeePerGas: feeData.maxFeePerGas?.mul(110).div(100), // 10% premium buffer
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.mul(110).div(100),
                    gasLimit: 350000 
                }
            );

            const receipt = await tx.wait();
            
            // Parse event log for exact profit tracking
            const iface = new ethers.utils.Interface(CONTRACT_ABI);
            receipt.logs.forEach((log) => {
                try {
                    const parsedLog = iface.parseLog(log);
                    if (parsedLog.name === "ArbitrageExecuted") {
                        const profit = parseFloat(ethers.utils.formatUnits(parsedLog.args.profitInUSDC, 6));
                        totalRealizedProfits += profit;
                        console.log(`✨ Success! Realized Profit: +${profit} USDC | Cumulative: ${totalRealizedProfits.toFixed(6)} USDC`);
                    }
                } catch { /* Not our target event */ }
            });

        } catch (err) {
            console.error(`❌ Execution Failed for Nonce ${nextAssignedNonce - 1}:`, err.message);
            // Re-sync nonce state on failure
            nextAssignedNonce = -1;
        } finally {
            activeInFlightPayloads--;
            // If the execution failed before entering async yield or after, clean lock loop
            if (mutexLock) releaseMutex();
        }
    }

    // Shard Matrix Allocator Configuration
    const SHARD_MATRICES = [
        [ROUTERS.QUICK, ROUTERS.SUSHI],                  // Shard 1: Direct AMM Matrix
        [ROUTERS.QUICK, ROUTERS.DFYN],                   // Shard 2: Cross AMM Matrix A
        [ROUTERS.SUSHI, ROUTERS.DFYN],                   // Shard 3: Cross AMM Matrix B
        [ROUTERS.QUICK, ROUTERS.SUSHI, ROUTERS.DFYN]     // Shard 4: Triangular Route Ring
    ];

    // Spawn Matrix Shard Workers
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

    process.on("SIGINT", () => {
        console.log("\n🛑 Gracefully shutting down Engine. Cleaning RPC pools...");
        if (provider && provider.destroy) provider.destroy();
        process.exit(0);
    });

// ============================================================================
// WORKER THREAD SCANNERS (Isolated Router Matrix Matrix)
// ============================================================================
} else {
    const { workerId, matrix } = workerData;

    parentPort.postMessage({
        type: "LOG",
        data: `🧵 [Shard #${workerId}] Worker initialized and ready | Matrix Allocation Count: [${matrix.length} Node Pairs]`
    });

    // High frequency memory scanning imitation loop
    setInterval(() => {
        // Simulated structural path evaluation derived from its assigned un-duplicated matrix
        const opportunityDetected = Math.random() > 0.98; 

        if (opportunityDetected) {
            const executionPayload = {
                paths: matrix,
                amountIn: ethers.utils.parseEther("1000") // 1000 MATIC base size
            };

            parentPort.postMessage({
                type: "EXECUTE_BATCH",
                payload: executionPayload
            });
        }
    }, 200); // 200ms quick-scan interval ticks
}

export { CONFIG, CONTRACT_ABI, STATIC_POLYGON_NETWORK };
