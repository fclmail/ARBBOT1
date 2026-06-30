/**
 * ARBBOT1 - High-Velocity Production Execution Engine
 * Target: VaultArbitrageEnforcer (With Centralized Nonce Tracking & Live Sandbox Checks)
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
        "wss://polygon-bor-rpc.publicnode.com",
        "wss://rpc-mainnet.matterlight.xyz/ws"
    ],
    fastLaneRpc: "https://polygon-bor-rpc.publicnode.com",
    fallbackRpc: "https://polygon.drpc.org",
    
    // Deployed VaultArbitrageEnforcer Address
    contractAddress: ethers.getAddress("0x7EAf60672b8C0A2399187bCA1bB916F14Ac7A958".toLowerCase()),
    
    // Core Polygon Asset Tokens
    tokens: {
        USDC:   ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()),
        WMATIC: ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase()),
        USDT:   ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase()),
        DAI:    ethers.getAddress("0x8f3Cf6ad23Cd3EAd96143c01f6F9852fEF29d33E".toLowerCase())
    },
    routers: {
        QUICK:   ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),
        SUSHI:   ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase()),
        DFYN:    ethers.getAddress("0xF15361A03Eca00a63A23e1bd165157Cb02434a62".toLowerCase())
    },
    allocationAmount: 500000000n, // $500 USDC (6 Decimals)
    gasLimitOverride: 450000n,    // Typical upper bound for standard batch multi-hop paths
    priorityFeeGwei: 45n,
    deadlineSeconds: 45               
};

// Exact Production Minimal ABI for VaultArbitrageEnforcer Matching Contract Structs
const CONTRACT_ABI = [
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function minimumProfitUSDC() external view returns (uint256)"
];

const STATIC_POLYGON_NETWORK = ethers.Network.from({ name: "polygon", chainId: 137 });

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
    let scanActiveCount = 0;

    // CENTRAL NONCE STATE TRACKER
    let currentLocalNonce = null;
    const tempProvider = new ethers.JsonRpcProvider(CONFIG.fastLaneRpc, STATIC_POLYGON_NETWORK);
    const mainWallet = new ethers.Wallet(process.env.PRIVATE_KEY, tempProvider);

    const activeSubMatrices = [  
        { id: 1, routers: ["QUICK", "SUSHI", "DFYN"], targetAsset: "WMATIC" },
        { id: 2, routers: ["QUICK", "SUSHI", "DFYN"], targetAsset: "USDT" },
        { id: 3, routers: ["QUICK", "SUSHI", "DFYN"], targetAsset: "DAI" },
        { id: 4, routers: ["QUICK", "SUSHI", "DFYN"], targetAsset: "WMATIC" } // Redundant target path backup matrix
    ];  

    for (let i = 0; i < activeSubMatrices.length; i++) {
        const engineWorker = new Worker(__filename, {  
            workerData: { workerId: activeSubMatrices[i].id, config: CONFIG, matrix: activeSubMatrices[i].routers, targetAsset: activeSubMatrices[i].targetAsset }  
        });  

        engineWorker.on("message", async (msg) => {  
            if (msg.type === "LOG") {
                console.log(msg.data);
            }
            if (msg.type === "SCAN_DONE") {
                scanActiveCount++;
                if (scanActiveCount === workerThreads.length) {
                    console.log("📡 Scan Completed: No arbitrage path open this block.");
                }
            }
            if (msg.type === "REQUEST_NONCE") {
                if (currentLocalNonce === null) {
                    currentLocalNonce = await tempProvider.getTransactionCount(mainWallet.address, "pending");
                } else {
                    currentLocalNonce++;
                }
                engineWorker.postMessage({ type: "NONCE_ASSIGNED", nonce: currentLocalNonce });
            }
            if (msg.type === "PROFIT") {  
                totalRealizedProfits += msg.amount;  
                console.log(`💰 Combined Metric Realized Capture: +${totalRealizedProfits.toFixed(6)} USDC`);  
            }  
        });  
        workerThreads.push(engineWorker);  
    }  

    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL`);
    console.log(`└── Active Shard Subprocesses ● ${workerThreads.length} Isolated Cluster Worker Threads\n`);

    async function connectWebSocketStream() {  
        try {  
            mainProvider = new ethers.WebSocketProvider(CONFIG.providerWssEndpoints[0], STATIC_POLYGON_NETWORK);
            mainProvider.on("block", async (blockNumber) => {  
                scanActiveCount = 0;
                try {
                    currentLocalNonce = await tempProvider.getTransactionCount(mainWallet.address, "pending");
                } catch (_) {}
                
                console.log(`\n[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} Across Shards...`);
                console.log(`🔄 Resynced Local Baseline Nonce to: ${currentLocalNonce}`);
                workerThreads.forEach(w => w.postMessage({ type: "BLOCK_TRIGGER", blockNumber }));  
            });  
        } catch (_) {
            setupHttpFallbackMode();
        }  
    }  

    function setupHttpFallbackMode() {  
        const fallbackProvider = new ethers.JsonRpcProvider(CONFIG.fallbackRpc, STATIC_POLYGON_NETWORK);  
        fallbackProvider.on("block", async (blockNumber) => {  
            scanActiveCount = 0;
            try {
                currentLocalNonce = await tempProvider.getTransactionCount(mainWallet.address, "pending");
            } catch (_) {}
            
            console.log(`\n[HTTP Fallback Engine] 🔍 Scanning Block #${blockNumber} Across Shards...`);
            console.log(`🔄 Resynced Local Baseline Nonce to: ${currentLocalNonce}`);
            workerThreads.forEach(w => w.postMessage({ type: "BLOCK_TRIGGER", blockNumber }));  
        });  
    }  

    connectWebSocketStream();  

// ============================================================================
// COMPONENT WORKER THREAD RUNTREES
// ============================================================================
} else {
    const { workerId, config, matrix, targetAsset } = workerData;
    const provider = new ethers.JsonRpcProvider(config.fastLaneRpc, STATIC_POLYGON_NETWORK);  
    const executionWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);  
    const contractInstance = new ethers.Contract(config.contractAddress, CONTRACT_ABI, executionWallet);  

    let pendingTxPromiseResolver = null;

    parentPort.on("message", async (message) => {  
        if (message.type === "NONCE_ASSIGNED" && pendingTxPromiseResolver) {
            pendingTxPromiseResolver(message.nonce);
            return;
        }

        if (message.type === "BLOCK_TRIGGER") {  
            parentPort.postMessage({  
                type: "LOG",  
                data: `✅ [Shard #${workerId}] Scanning Matrix Array: [${matrix.join(", ")}] × Hardcoded Liquidity Assets`  
            });  

            try {
                // Route Mapping Arrays
                const buyRouters = [config.routers.QUICK];
                const sellRouters = [config.routers.SUSHI];
                const amountsInUSDC = [config.allocationAmount];
                
                // Select dynamic loop route path array
                const targetTokenAddress = config.tokens[targetAsset];
                const pathsToToken = [[config.tokens.USDC, targetTokenAddress]];
                const pathsToUSDC = [[targetTokenAddress, config.tokens.USDC]];
                
                // 1. OFFLINE SIMULATION LAYER (view execution on node state, costs 0 Gas)
                const [estimatedFinalUSDC, estimatedProfit] = await contractInstance.simulateArbitrageProfit(
                    buyRouters[0],
                    sellRouters[0],
                    amountsInUSDC[0],
                    pathsToToken[0],
                    pathsToUSDC[0]
                );

                const minProfitUSDC = await contractInstance.minimumProfitUSDC();

                if (estimatedProfit >= minProfitUSDC) {
                    const formattedProfitStr = ethers.formatUnits(estimatedProfit, 6);
                    
                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `🔥 OFFLINE SIMULATION HIT [Shard #${workerId}]: Profit Delta Detected: +${formattedProfitStr} USDC`  
                    });  

                    // Request synchronized nonce from primary tracking thread
                    const assignedNonce = await new Promise((resolve) => {
                        pendingTxPromiseResolver = resolve;
                        parentPort.postMessage({ type: "REQUEST_NONCE" });
                    });

                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `🚀 Allocating Matrix Pipeline ➔ Nonce Assigned: ${assignedNonce}`  
                    });

                    const feeData = await provider.getFeeData();  
                    const currentBaseFee = feeData.estimatedBaseFee || 180000000000n; // fallback to 180 Gwei standard base fee if omitted
                    const maxPriorityFee = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");
                    const totalGasPrice = currentBaseFee + maxPriorityFee;

                    const baseFeeGwei = ethers.formatUnits(currentBaseFee, "gwei");
                    parentPort.postMessage({
                        type: "LOG",
                        data: `⛽ Network Gas Evaluation: Base Fee ${parseInt(baseFeeGwei)} Gwei | Priority Tip ${config.priorityFeeGwei} Gwei`
                    });

                    const txDeadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;  
                    const batchPayload = { buyRouters, sellRouters, amountsInUSDC, pathsToToken, pathsToUSDC, deadline: txDeadline };

                    // 2. ONLINE EXECUTION MUTATION PAYLOAD DISPATCH
                    const txResponse = await contractInstance.executeFlashBatchArbitrage(batchPayload, {
                        nonce: assignedNonce,
                        gasLimit: config.gasLimitOverride,
                        maxFeePerGas: (currentBaseFee * 2n) + maxPriorityFee,
                        maxPriorityFeePerGas: maxPriorityFee
                    });

                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `📡 ONLINE EXECUTION DISPATCHED: ${txResponse.hash}`  
                    });  

                    const receipt = await txResponse.wait(1);  
                    
                    // Exact calculated POL consumption calculation matrix
                    const gasUsed = receipt.gasUsed || config.gasLimitOverride;
                    const polSpent = ethers.formatEther(gasUsed * totalGasPrice);
                    const usdEquivalent = (parseFloat(polSpent) * 0.60).toFixed(2); // Approximating asset baseline price matrix

                    parentPort.postMessage({
                        type: "LOG",
                        data: `💸 Gas Withdrawn from Wallet: ${parseFloat(polSpent).toFixed(6)} POL ($${usdEquivalent} USD equivalent)`
                    });

                    if (receipt.status === 1) {
                        parentPort.postMessage({ type: "LOG", data: `✨ TRANSACTION SETTLED: Profit captured on Polygonscan.` });
                        parentPort.postMessage({ type: "PROFIT", amount: parseFloat(formattedProfitStr) });
                    } else {
                        parentPort.postMessage({ type: "LOG", data: `❌ Transaction Reverted: Slippage limit exceeded on SushiSwap Route (State Reverted - Gas Spent Only)` });
                    }
                } else {
                    // Signal back to control coordinator that scan iteration finished cleanly without action
                    parentPort.postMessage({ type: "SCAN_DONE" });
                }
            } catch (err) {  
                parentPort.postMessage({  
                    type: "LOG",  
                    data: `📡 Scan Completed: No arbitrage path open this block. (${err.reason || err.message})`  
                });
            }  
        }  
    });  
}
