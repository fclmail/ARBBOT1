/**
 * ARBBOT1 - High-Velocity Multi-Hop Production Execution Engine
 * Architecture: WSS Resilient Stream Pool -> Multi-Thread Worker Cluster
 * Specification: Ethers v6 Production Build with Matrix Asset Expansions
 */
import { ethers } from "ethers";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// COMPREHENSIVE PRODUCTION CONFIGURATION
// ============================================================================
const CONFIG = {
    providerWssEndpoints: [
        "wss://polygon-rpc.com/ws",
        "wss://polygon-bor-rpc.publicnode.com",
        "wss://rpc-mainnet.matterlight.xyz/ws"
    ],
    fastLaneRpc: process.env.FAST_LANE_RPC || process.env.RPC_URL || "https://polygon-rpc.com", 
    fallbackRpc: "https://polygon.drpc.org",
    
    contractAddress: ethers.getAddress("0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958"),
    
    // Core Base Asset Definitions
    usdcAddress: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"), // Bridged USDC.e
    wmaticAddress: ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),
    
    gasLimitOverride: 850000n,
    priorityFeeGwei: 45n,
    candidateSizes: [
        "100000" // Updated to 100,000 micro-units based on system ledger configurations
    ],
    routers: {
        QUICK: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
        SUSHI: ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
        DFYN:  ethers.getAddress("0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429") // Checksum Solved via Lowercase Auto-Format
    },
    maxPendingTransactions: 1,        
    deadlineSeconds: 45              
};

const CONTRACT_ABI = [
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function executeBalancerFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() external view returns (uint256)",
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC) external view returns ((uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit) best)"
];

const STATIC_POLYGON_NETWORK = ethers.Network.from({ 
    name: "polygon", 
    chainId: 137,
    allowUnknownNetworks: false 
});

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

    // Distributing balanced Shards across routers
    const activeSubMatrices = [  
        { id: 1, routers: ["QUICK", "SUSHI", "DFYN"], routeStrategy: "TRIPLE_HOP_A" },
        { id: 2, routers: ["QUICK", "SUSHI", "DFYN"], routeStrategy: "TRIPLE_HOP_B" },
        { id: 3, routers: ["QUICK", "SUSHI", "DFYN"], routeStrategy: "QUAD_HOP_A" },
        { id: 4, routers: ["QUICK", "SUSHI", "DFYN"], routeStrategy: "STANDARD_CYCLIC" }
    ];  

    const totalWorkers = activeSubMatrices.length;  
   
    for (let i = 0; i < totalWorkers; i++) {
        const engineWorker = new Worker(__filename, {  
            workerData: { 
                workerId: activeSubMatrices[i].id, 
                config: CONFIG, 
                matrix: activeSubMatrices[i].routers,
                strategy: activeSubMatrices[i].routeStrategy
            }  
        });  

        engineWorker.on("message", (msg) => {  
            if (msg.type === "LOG") {  
                console.log(msg.data);  
            } else if (msg.type === "PROFIT") {  
                totalRealizedProfits += msg.amount;  
                console.log(`💰 Combined Metric Realized Capture: ${totalRealizedProfits >= 0 ? '+' : ''}${totalRealizedProfits.toFixed(6)} USDC`);  
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

            mainProvider = new ethers.WebSocketProvider(targetEndpoint, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });
           
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
            isRotating = false;
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
    const { workerId, config, matrix, strategy } = workerData;
    const fastLaneRelayProvider = new ethers.JsonRpcProvider(config.fastLaneRpc, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });  
    const executionWallet = new ethers.Wallet(process.env.PRIVATE_KEY, fastLaneRelayProvider);  
    const vaultInstance = new ethers.Contract(config.contractAddress, CONTRACT_ABI, executionWallet);  
    
    const tokenContract = new ethers.Contract(config.usdcAddress, ["function balanceOf(address) view returns (uint256)"], fastLaneRelayProvider);

    // Immutable Smart Contract Synced Asset Addresses
    const TOKENS = {
        USDC: config.usdcAddress,
        WMATIC: config.wmaticAddress,
        WETH: ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"),
        WBTC: ethers.getAddress("0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"),
        DAI: ethers.getAddress("0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"),
        USDT: ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F")
    };

    let pendingTransactionsCount = 0;

    parentPort.on("message", async (message) => {  
        if (message.type === "BLOCK_TRIGGER") {  
            if (pendingTransactionsCount >= config.maxPendingTransactions) return;

            parentPort.postMessage({  
                type: "LOG",  
                data: `✅ [Shard #${workerId}] Scanning Matrix Array: [${matrix.join(", ")}] Strategy: [${strategy}]`  
            });  

            // Generate Pathing Sequences based on Shard Allocation
            let pathToToken = [];
            let pathToUSDC = [];

            switch(strategy) {
                case "TRIPLE_HOP_A":
                    pathToToken = [TOKENS.USDC, TOKENS.WETH, TOKENS.WMATIC];
                    pathToUSDC  = [TOKENS.WMATIC, TOKENS.USDC];
                    break;
                case "TRIPLE_HOP_B":
                    pathToToken = [TOKENS.USDC, TOKENS.WBTC, TOKENS.WETH];
                    pathToUSDC  = [TOKENS.WETH, TOKENS.USDC];
                    break;
                case "QUAD_HOP_A":
                    pathToToken = [TOKENS.USDC, TOKENS.WBTC, TOKENS.WETH, TOKENS.DAI];
                    pathToUSDC  = [TOKENS.DAI, TOKENS.USDC];
                    break;
                case "STANDARD_CYCLIC":
                default:
                    pathToToken = [TOKENS.USDC, TOKENS.WMATIC];
                    pathToUSDC  = [TOKENS.WMATIC, TOKENS.USDC];
                    break;
            }

            const buyRouter = matrix[workerId % matrix.length];
            const sellRouter = matrix[(workerId + 1) % matrix.length];

            pendingTransactionsCount++;
            try {  
                const feeData = await fastLaneRelayProvider.getFeeData();  
                const currentBaseFee = feeData.estimatedBaseFee || ethers.parseUnits("140", "gwei");  
                const baseFeeGwei = ethers.formatUnits(currentBaseFee, "gwei").split(".")[0];

                const candidateSizesRaw = [ethers.parseUnits(config.candidateSizes[0], 0)]; 
                const deadline = BigInt(Math.floor(Date.now() / 1000) + config.deadlineSeconds);

                // Off-chain Quadratic/Ternary Optimization Probe
                let simulationResult;
                try {
                    simulationResult = await vaultInstance.findBestFlashLoanSize(
                        buyRouter,
                        sellRouter,
                        candidateSizesRaw, 
                        pathToToken,
                        pathToUSDC,
                        { from: executionWallet.address }
                    );
                } catch (simError) {
                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `ℹ️ [Shard #${workerId}] Sandbox execution reverted (Structural liquidity curve sub-optimal).`  
                    });
                    pendingTransactionsCount--;
                    return;
                }

                if (!simulationResult || simulationResult.estimatedProfit < 1n) {
                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `🛑 [SC Sandbox Blocked] Built-in simulation reports profit below threshold. Dropping transaction.`  
                    });
                    pendingTransactionsCount--;
                    return; 
                }

                parentPort.postMessage({  
                    type: "LOG",  
                    data: `🔥 PROFITABLE MULTI-HOP ASSET MATRIX DETECTED [Shard #${workerId}]\n├── Route Strategy Profile: ${strategy}\n├── Peak Input Size Target: ${config.candidateSizes[0]} Micro-Units\n├── Gross Estimated Yield: +${ethers.formatUnits(simulationResult.estimatedProfit, 6)} USDC\n└── Network Base Fee: ${baseFeeGwei} Gwei | Priority Fee: ${config.priorityFeeGwei} Gwei`  
                });  

                parentPort.postMessage({  
                    type: "LOG",  
                    data: `📦 Dispatched On-Chain Flash Arbitrage Batch...\n├── Tx Hash: Awaiting Broadcast...\n├── Gas Limit Allocated: ${config.gasLimitOverride.toString()}\n└── Awaiting Block Inclusion...`  
                });

                const balanceBefore = await tokenContract.balanceOf(config.contractAddress);

                const tx = await vaultInstance.executeBestFlashLoanArbitrage(
                    buyRouter,
                    sellRouter,
                    candidateSizesRaw,
                    pathToToken,
                    pathToUSDC,
                    deadline,
                    {
                        gasLimit: config.gasLimitOverride,
                        maxPriorityFeePerGas: ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei"),
                        maxFeePerGas: (currentBaseFee * 2n) + ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei")
                    }
                );

                parentPort.postMessage({ type: "LOG", data: `📡 Broadcasted! Tx Hash: ${tx.hash}` });

                const receipt = await tx.wait();
                
                if (receipt.status === 1) {
                    const balanceAfter = await tokenContract.balanceOf(config.contractAddress);
                    const actualProfitRaw = balanceAfter - balanceBefore;
                    
                    // Numerical Calculation Engine for Net +/- Total Parsing
                    const gasUsed = BigInt(receipt.gasUsed);
                    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice);
                    const totalGasCostWei = gasUsed * effectiveGasPrice;
                    const estimatedGasCostUSDC = Number(totalGasCostWei) / 1e12; // Scaled to token decimal offset

                    const grossProfitUSD = Number(actualProfitRaw) / 1000000;
                    const netProfitUSD = grossProfitUSD - estimatedGasCostUSDC;
                    const signPrefix = netProfitUSD >= 0 ? "+" : "";

                    if (actualProfitRaw > 0n) {
                        parentPort.postMessage({  
                            type: "LOG",  
                            data: `✔️ Transaction Confirmed in Block #${receipt.blockNumber}!\n` +
                                  `├── Status: SUCCESS ✅\n` +
                                  `├── Gross Captured:  +${grossProfitUSD.toFixed(6)} USDC\n` +
                                  `├── Network Gas Fees: -${estimatedGasCostUSDC.toFixed(6)} USDC\n` +
                                  `└── Net Realized PnL: [${signPrefix}${netProfitUSD.toFixed(6)} USDC] 📊`
                        });
                        parentPort.postMessage({ type: "PROFIT", amount: netProfitUSD });
                    } else {
                        parentPort.postMessage({  
                            type: "LOG",  
                            data: `⚠️ Transaction Executed Flat (Slippage Reverted)\n` +
                                  `├── Gross Captured:   0.000000 USDC\n` +
                                  `├── Network Gas Fees: -${estimatedGasCostUSDC.toFixed(6)} USDC\n` +
                                  `└── Net Realized PnL: [-${estimatedGasCostUSDC.toFixed(6)} USDC] 🔻`
                        });
                        parentPort.postMessage({ type: "PROFIT", amount: -estimatedGasCostUSDC });
                    }
                } else {
                    parentPort.postMessage({ type: "LOG", data: `❌ Transaction reverted on-chain.` });
                }

            } catch (txError) {
                parentPort.postMessage({ type: "LOG", data: `⚠️ Batch execution skipped or dropped: ${txError.message}` });
            } finally {
                pendingTransactionsCount--;
            }
        }
    });
}
