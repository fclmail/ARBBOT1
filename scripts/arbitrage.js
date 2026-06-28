/**
 * ARBBOT1 - High-Velocity Production Execution & Diagnostic Engine
 * Architecture: WSS Resilient Stream Pool -> Multi-Thread Worker Cluster -> FastLane Bundle Relay
 * Specification: Ethers v6 Production Build
 * Mode: DYNAMIC SIZE TESTING & TARGET VERBOSE DIAGNOSTICS
 * Structure: Micro-unit profit optimization calibrated for minimumProfitUSDC = 1
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
        "1000000",            // $1.00 USDC
        "10000000",           // $10.00 USDC
        "50000000",           // $50.00 USDC
        "100000000",          // $100.00 USDC
        "500000000",          // $500.00 USDC
        "1000000000"          // $1,000.00 USDC
    ],
    routers: {
        QUICK:   ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),
        SUSHI:   ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase())
    },
    immediateExecution: false,        
    revalidateBeforeSend: true,       
    executeOnFirstProfit: true,       
    maxPendingTransactions: 1,        
    blockConfirmConfirmations: 1,      
    deadlineSeconds: 45               
};

const CONTRACT_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "buyRouter", "type": "address" },
            { "internalType": "address", "name": "sellRouter", "type": "address" },
            { "internalType": "uint256[]", "name": "candidateSizes", "type": "uint256[]" },
            { "internalType": "address[]", "name": "pathToToken", "type": "address[]" },
            { "internalType": "address[]", "name": "pathToUSDC", "type": "address[]" }
        ],
        "name": "findBestFlashLoanSize",
        "outputs": [
            {
                "components": [
                    { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
                    { "internalType": "uint256", "name": "estimatedFinalUSDC", "type": "uint256" },
                    { "internalType": "uint256", "name": "estimatedProfit", "type": "uint256" }
                ],
                "internalType": "struct VaultArbitrageEnforcer.SimulationResult",
                "name": "best",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
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

    console.log("🚀 PRODUCTION RUNNER STARTING: CONFIG BALANCED FOR MICRO-UNIT ARBITRAGE");  
    console.log(`📡 Target RPC Endpoint: ${CONFIG.fastLaneRpc}`);  

    let totalRealizedProfits = 0.0;  
    let workerThreads = [];  
    let mainProvider;  
    let currentEndpointIndex = 0;  
    let isRotating = false;  
    let fallbackTriggered = false;  
    let activeEngineName = "WebSocket Stream Cluster";  
    let blockWatchdogTimeout;

    const coreBridges = [  
        { name: "WMATIC",   token: ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase()) },  
        { name: "USDT",     token: ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase()) },  
        { name: "DAI",      token: ethers.getAddress("0x8f3cf7ad23cd3cadbd9735aff958023239c6a063".toLowerCase()) },  
        { name: "AAVE",     token: ethers.getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b".toLowerCase()) },
        { name: "CRV",      token: ethers.getAddress("0x172370d5cd63279efa6d502dab29171933a610af".toLowerCase()) },
        { name: "QUICK",    token: ethers.getAddress("0x831753dd7087cac61ab5644b308642cc1c33dc13".toLowerCase()) },
        { name: "LINK",     token: ethers.getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39".toLowerCase()) },
        { name: "WBTC",     token: ethers.getAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6".toLowerCase()) },
        { name: "UNI",      token: ethers.getAddress("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984".toLowerCase()) }
    ];  

    const totalWorkers = coreBridges.length;  

    for (let i = 0; i < totalWorkers; i++) {  
        const engineWorker = new Worker(__filename, {  
            workerData: { workerId: i + 1, config: CONFIG, primaryAsset: coreBridges[i] }  
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

    // Setup a watchdog timer to force rotation if a connection hangs silently without streaming blocks
    function resetBlockWatchdog() {
        clearTimeout(blockWatchdogTimeout);
        if (fallbackTriggered) return;
        blockWatchdogTimeout = setTimeout(() => {
            console.log(`⚠️ [Watchdog] Current pipeline stream stalled. Rotating connection target...`);
            attemptFallbackRotation();
        }, 6000); 
    }

    async function connectWebSocketStream() {  
        if (fallbackTriggered) return;  
        const targetEndpoint = CONFIG.providerWssEndpoints[currentEndpointIndex];  
          
        try {  
            if (mainProvider) {  
                try { mainProvider.removeAllListeners(); await mainProvider.destroy(); } catch (_) {}  
            }  

            // Instantiated with custom connection timeout handling rather than native unmanaged execution
            mainProvider = new ethers.WebSocketProvider(targetEndpoint, STATIC_POLYGON_NETWORK);
            
            if (mainProvider.websocket) {
                mainProvider.websocket.on("error", () => attemptFallbackRotation());
                mainProvider.websocket.on("close", () => attemptFallbackRotation());
            }
              
            console.log(`\n═══════════════════════════════════════════════════════════`);  
            console.log(`  🌐 PRODUCTION MATRIX ENGINE OPERATIONAL                   `);  
            console.log(`  └── Active Shard Subprocesses ● ${totalWorkers} Managed Sub-pipelines`);  
            console.log(`═══════════════════════════════════════════════════════════\n`);  

            isRotating = false;   
            resetBlockWatchdog();

            mainProvider.on("block", async (blockNumber) => {  
                resetBlockWatchdog();
                console.log(`[${activeEngineName}] 🔍 Scanning Block #${blockNumber} Across Shards...`);
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
        activeEngineName = "HTTP Fallback Engine";  
        console.log(`🚨 Switching Cluster to Active HTTPS Polling Fallback via: ${CONFIG.fallbackRpc}`);
        const fallbackProvider = new ethers.JsonRpcProvider(CONFIG.fallbackRpc, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });  
        fallbackProvider.on("block", (blockNumber) => {  
            console.log(`[${activeEngineName}] 🔍 Scanning Block #${blockNumber}...`);
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
    const { workerId, config, primaryAsset } = workerData;
    const fastLaneRelayProvider = new ethers.JsonRpcProvider(config.fastLaneRpc, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });  
    const executionWallet = new ethers.Wallet(process.env.PRIVATE_KEY, fastLaneRelayProvider);  
    const vaultInstance = new ethers.Contract(config.contractAddress, CONTRACT_ABI, executionWallet);  

    let pendingTransactionsCount = 0;
    let cachedMinProfit = 1n; 

    vaultInstance.minimumProfitUSDC().then(val => { cachedMinProfit = val; }).catch(() => {});

    parentPort.postMessage({  
        type: "LOG",  
        data: `✅ [Shard #${workerId}] Diagnostic Scanner Engine Primed. Vector: ${primaryAsset.name}`  
    });  

    parentPort.on("message", async (message) => {  
        if (message.type === "BLOCK_TRIGGER") {  
            const routerIdentifiers = Object.keys(config.routers);  

            if (pendingTransactionsCount >= config.maxPendingTransactions) return; 

            try {  
                const feeData = await fastLaneRelayProvider.getFeeData();  
                const currentBaseFee = feeData.estimatedBaseFee || 0n;  
                const calculatedMaxPriority = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");  
                const calculatedMaxFee = (currentBaseFee * 2n) + calculatedMaxPriority;  

                for (let b = 0; b < routerIdentifiers.length; b++) {  
                    for (let s = 0; s < routerIdentifiers.length; s++) {  
                        
                        if (pendingTransactionsCount >= config.maxPendingTransactions) break;

                        const buyRouterName = routerIdentifiers[b];  
                        const sellRouterName = routerIdentifiers[s];  
                        
                        if (buyRouterName === sellRouterName) continue;

                        const buyRouterAddress = config.routers[buyRouterName];  
                        const sellRouterAddress = config.routers[sellRouterName];  

                        const pathToToken = [config.usdcAddress, primaryAsset.token];  
                        const pathToUSDC = [primaryAsset.token, config.usdcAddress];  

                        try {  
                            const simulation = await vaultInstance.findBestFlashLoanSize(  
                                buyRouterAddress,  
                                sellRouterAddress,  
                                config.candidateSizes,  
                                pathToToken,  
                                pathToUSDC  
                            );  

                            const amountIn = simulation.best.amountIn;
                            const estimatedFinalUSDC = simulation.best.estimatedFinalUSDC; 
                            const estimatedProfit = simulation.best.estimatedProfit;

                            if (amountIn === 0n || estimatedFinalUSDC === 0n) {
                                continue;   
                            }

                            if (estimatedProfit >= cachedMinProfit && estimatedProfit > 0n) {  
                                const rawProfitNormalized = Number(estimatedProfit) / 1e6;  
                                
                                pendingTransactionsCount++;

                                parentPort.postMessage({  
                                    type: "LOG",  
                                    data: `\x1b[32m🔥 PROFITABLE SPREAD FOUND [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} | Expected Net Yield: +${rawProfitNormalized} USDC\x1b[0m`  
                                });  

                                const txDeadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;  

                                vaultInstance.executeBestFlashLoanArbitrage(  
                                    buyRouterAddress,  
                                    sellRouterAddress,  
                                    config.candidateSizes,  
                                    pathToToken,  
                                    pathToUSDC,  
                                    txDeadline,  
                                    {  
                                        gasLimit: config.gasLimitOverride,  
                                        maxFeePerGas: calculatedMaxFee,  
                                        maxPriorityFeePerGas: calculatedMaxPriority
                                    }
                                ).then(async (txResponse) => {
                                    parentPort.postMessage({  
                                        type: "LOG",  
                                        data: `🚀 Bundle Broadcast Sent to Fastlane Relay: ${txResponse.hash}`  
                                    });  

                                    const receipt = await txResponse.wait(config.blockConfirmConfirmations);  
                                    pendingTransactionsCount--; 

                                    if (receipt.status === 1) {  
                                        parentPort.postMessage({  
                                            type: "LOG",  
                                            data: `✨ EXECUTION SUCCESS! On-chain execution finalized successfully.`  
                                        });  
                                        parentPort.postMessage({ type: "PROFIT", amount: rawProfitNormalized });  
                                    } else {  
                                        parentPort.postMessage({  
                                            type: "LOG",  
                                            data: `🔴 On-chain Transaction Reverted: ${txResponse.hash}`  
                                        });  
                                    }  
                                }).catch((txError) => {  
                                    pendingTransactionsCount--;  
                                    parentPort.postMessage({  
                                        type: "LOG",  
                                        data: `⚠️ Dispatcher Intercepted Error: ${txError.message}`  
                                    });  
                                });

                                if (config.executeOnFirstProfit) break;
                            } else {
                                parentPort.postMessage({
                                    type: "LOG",
                                    data: `ℹ️ [Shard #${workerId}] Route ${buyRouterName}➔${sellRouterName} liquid but unprofitable (Returned ${estimatedFinalUSDC.toString()} for input ${amountIn.toString()}).`
                                });
                            }
                        } catch (simError) {  
                            if (simError.message && simError.message.includes("execution reverted")) {
                                parentPort.postMessage({
                                    type: "LOG",
                                    data: `❌ [Shard #${workerId} Revert] ${buyRouterName}➔${sellRouterName} path missing required liquid pool depth.`
                                });
                            }
                        }  
                    }  
                    if (config.executeOnFirstProfit && pendingTransactionsCount >= config.maxPendingTransactions) break;
                }
            } catch (err) {  
                // Safety catch for standard node runtime noise
            }  
        }  
    });  
}
