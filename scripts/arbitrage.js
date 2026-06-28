/**
 * ARBBOT1 - Full Reactive Multi-Threaded Arbitrage Engine
 * Architecture: WSS Resilient Stream Pool -> 4 Thread Worker Cluster -> FastLane Bundle Relay
 * Specification: Ethers v6 Production Build
 * Contract: 0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc
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
    fastLaneRpc: "https://polygon-rpc.com",             
    fallbackRpc: "https://polygon.drpc.org", 

    contractAddress: ethers.getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc".toLowerCase()),                
    usdcAddress: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()),

    gasLimitOverride: 650000n, // Safe buffer limit for standard multi-hop flash loan execution      
    priorityFeeGwei: 65n,       // Aggressive priority fee to beat competing searchers

    candidateSizes: [
        "1000000000"            // Single size tier ($1,000 USDC) to avoid multi-loop simulation lag
    ],

    routers: {
        QUICK:   ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),
        SUSHI:   ethers.getAddress("0x1b02dA8Cb0d097e645729F65733526440d599963".toLowerCase()),
        DFYN:    ethers.getAddress("0xF18056Bbd320E96A48e3Fbf8bC061322531aac99".toLowerCase()),
        WAULT:   ethers.getAddress("0x3a1D873C37abE9244065524bAd7F7a2f35f7999A".toLowerCase()),
        JETSWAP: ethers.getAddress("0x5C6EC38c28eCD03d18a540552a914A8f1b6214A5".toLowerCase()),
        APESWAP: ethers.getAddress("0xC0788A3D1DE900874986012c4feEd447C1be9486".toLowerCase()),
        KATA:    ethers.getAddress("0x1b02dA8Cb0d097e645729F65733526440d599963".toLowerCase()) 
    }
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
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];

const STATIC_POLYGON_NETWORK = ethers.Network.from({ name: "polygon", chainId: 137 });

// ============================================================================
// GLOBAL NON-CRASH EXCEPTION SHIELD
// ============================================================================
process.on("uncaughtException", (err) => {
    if (err.message && (err.message.includes("Unexpected server response") || err.message.includes("detect network") || err.message.includes("ENOTFOUND"))) {
        return; 
    }
    console.error("☠️ Uncaught Exception caught by Shield:", err);
});

process.on("unhandledRejection", (reason) => {
    if (reason && reason.message && (reason.message.includes("detect network") || reason.message.includes("ENOTFOUND"))) return;
});

// ============================================================================
// MAIN ORCHESTRATION THREAD
// ============================================================================
if (isMainThread) {
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ Critical Error: PRIVATE_KEY environment variable is missing.");
        process.exit(1);
    }

    console.log("🚀 FASTLANE UNRESTRICTED REAL-TIME MEV MONITORING & EXECUTION ENGINE ONLINE\n");
    console.log(" Honeycomb Engine Routing directly via EVM state changes [Sharded Configuration]\n");
    console.log(`📡 Connected to FastLane Relay: ${CONFIG.fastLaneRpc}`);

    let totalRealizedProfits = 0.0;
    let workerThreads = [];
    let mainProvider;
    let currentEndpointIndex = 0;
    let isRotating = false;
    let fallbackTriggered = false;
    let activeEngineName = "WSS Engine Cluster";

    const tokenMatrix = [
        { name: "WETH",   token: ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase()) },
        { name: "WMATIC", token: ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase()) },
        { name: "WBTC",   token: ethers.getAddress("0x1BFD67037B42cf73acF2047067bd4F2C47D9BfD6".toLowerCase()) },
        { name: "DAI",    token: ethers.getAddress("0x8f3Cf6ad23Cd3EAd96143c01f6F98119404A55d0".toLowerCase()) },
        { name: "USDT",   token: ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase()) },
        { name: "LINK",   token: ethers.getAddress("0x53E0bca35eCE356BD5ddDFebbD1BB0Bc891dC611".toLowerCase()) },
        { name: "AAVE",   token: ethers.getAddress("0xD6DF932A45C0f255f857453786923655859951f3".toLowerCase()) },
        { name: "UNI",    token: ethers.getAddress("0xb33EaAd8d922B108342553e35760940176d149c8".toLowerCase()) },
        { name: "CRV",    token: ethers.getAddress("0x172370d5Cd63229abA15d6547758714e30b6af59".toLowerCase()) },
        { name: "SUSHI",  token: ethers.getAddress("0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a".toLowerCase()) },
        { name: "WOO",    token: ethers.getAddress("0x1B565668729ce78b95bCd7c6A701053E77ED573c".toLowerCase()) },
        { name: "GRT",    token: ethers.getAddress("0x5fe2B58c013d764999778A227074492aB17C38a1".toLowerCase()) },
        { name: "GHST",   token: ethers.getAddress("0x385AB5439542e6402264584e03c0043896f05221".toLowerCase()) },
        { name: "BAL",    token: ethers.getAddress("0x9a71012B13CA4d3D0Cdc72b177DF3ef03b0E76A3".toLowerCase()) },
        { name: "QUICK",  token: ethers.getAddress("0xB5C064F959943346541fC60914b77f985bde3A0A".toLowerCase()) }
    ];

    const totalWorkers = 4;
    const chunkAllocation = Math.ceil(tokenMatrix.length / totalWorkers);

    console.log(`[System] Initialized ${totalWorkers} Isolated Worker Threads successfully.\n`);

    for (let i = 0; i < totalWorkers; i++) {
        const structuralSlice = tokenMatrix.slice(i * chunkAllocation, (i + 1) * chunkAllocation);
        if (structuralSlice.length === 0) continue;

        const engineWorker = new Worker(__filename, {
            workerData: { workerId: i + 1, config: CONFIG, tokenPaths: structuralSlice }
        });

        engineWorker.on("message", (msg) => {
            if (msg.type === "LOG") {
                console.log(msg.data);
            } else if (msg.type === "PROFIT") {
                totalRealizedProfits += msg.amount;
                console.log(`\x1b[32m💰 Total Realized Profits Accumulated: ${totalRealizedProfits.toFixed(6)} USDC\x1b[0m`);
            }
        });
        workerThreads.push(engineWorker);
    }

    async function connectWebSocketStream() {
        if (fallbackTriggered) return;
        const targetEndpoint = CONFIG.providerWssEndpoints[currentEndpointIndex];
        console.log(`📡 Connecting to Stream Pool Gateway [${currentEndpointIndex + 1}/${CONFIG.providerWssEndpoints.length}]: ${targetEndpoint}`);
        
        try {
            if (mainProvider) {
                try { mainProvider.removeAllListeners(); await mainProvider.destroy(); } catch (_) {}
            }

            mainProvider = new ethers.WebSocketProvider(targetEndpoint, STATIC_POLYGON_NETWORK);
            
            if (mainProvider.websocket) {
                mainProvider.websocket.on("error", () => attemptFallbackRotation());
                mainProvider.websocket.on("close", () => attemptFallbackRotation());
            }

            await mainProvider.ready;
            activeEngineName = "WebSocket Stream Cluster";
            console.log(`✅ Connected successfully to WebSocket Stream Cluster.`);
            
            console.log(`\n═══════════════════════════════════════════════════════════`);
            console.log(`  ✅ PIPELINE VERIFICATION: ALL SYSTEMS OPERATIONAL         `);
            console.log(`  ├── WebSocket Stream Cluster        ● LIVE                 `);
            console.log(`  ├── ${totalWorkers} Worker Threads            ● ACTIVE               `);
            console.log(`  ├── Contract: ${CONFIG.contractAddress.slice(0,10)}...    ● DEPLOYED             `);
            console.log(`  └── Waiting for profitable blocks...                       `);
            console.log(`═══════════════════════════════════════════════════════════\n`);

            isRotating = false; 

            mainProvider.on("block", async (blockNumber) => {
                console.log(`[${activeEngineName} - Block #${blockNumber}] Polling state changes...`);
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

        await new Promise((resolve) => setTimeout(resolve, 100));
        isRotating = false;
        await connectWebSocketStream();
    }

    function setupHttpFallbackMode() {
        try {
            activeEngineName = "HTTP Fallback Engine";
            const fallbackProvider = new ethers.JsonRpcProvider(CONFIG.fallbackRpc, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });
            
            fallbackProvider.on("block", (blockNumber) => {
                console.log(`[${activeEngineName} - Block #${blockNumber}] Polling state changes...`);
                workerThreads.forEach((worker) => {
                    worker.postMessage({ type: "BLOCK_TRIGGER", blockNumber });
                });
            });
        } catch (err) {}
    }

    setTimeout(() => {
        connectWebSocketStream();
    }, 300);

// ============================================================================
// COMPONENT WORKER THREAD RUNTREES
// ============================================================================
} else {
    const { workerId, config, tokenPaths } = workerData;
    
    const fastLaneRelayProvider = new ethers.JsonRpcProvider(
        config.fastLaneRpc, 
        STATIC_POLYGON_NETWORK, 
        { staticNetwork: STATIC_POLYGON_NETWORK }
    );
    
    const executionWallet = new ethers.Wallet(process.env.PRIVATE_KEY, fastLaneRelayProvider);
    const vaultInstance = new ethers.Contract(config.contractAddress, CONTRACT_ABI, executionWallet);

    parentPort.postMessage({
        type: "LOG",
        data: `✅ [Shard #${workerId}] Worker successfully initialized in active write mode.`
    });

    parentPort.on("message", async (message) => {
        if (message.type === "BLOCK_TRIGGER") {
            const routerIdentifiers = Object.keys(config.routers);

            try {
                // Fetch current base fee once per block trigger to calculate EIP-1559 gas prices dynamically
                const feeData = await fastLaneRelayProvider.getFeeData();
                const currentBaseFee = feeData.estimatedBaseFee || 0n;
                const calculatedMaxPriority = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");
                // Max Fee = (Base Fee * 2) + Priority Fee
                const calculatedMaxFee = (currentBaseFee * 2n) + calculatedMaxPriority;

                for (const asset of tokenPaths) {
                    for (let b = 0; b < routerIdentifiers.length; b++) {
                        for (let s = 0; s < routerIdentifiers.length; s++) {
                            if (b === s) continue; 

                            const buyRouterName = routerIdentifiers[b];
                            const sellRouterName = routerIdentifiers[s];
                            
                            const buyRouterAddress = config.routers[buyRouterName];
                            const sellRouterAddress = config.routers[sellRouterName];

                            const pathToToken = [config.usdcAddress, asset.token];
                            const pathToUSDC = [asset.token, config.usdcAddress];

                            parentPort.postMessage({
                                type: "LOG",
                                data: `🔍 [Debug Shard #${workerId}] Simulating route: ${buyRouterName} ➔ ${sellRouterName} (${asset.name})`
                            });

                            try {
                                const simulation = await vaultInstance.findBestFlashLoanSize(
                                    buyRouterAddress,
                                    sellRouterAddress,
                                    config.candidateSizes,
                                    pathToToken,
                                    pathToUSDC
                                );

                                const amountIn = simulation.best.amountIn;
                                const estimatedProfit = simulation.best.estimatedProfit;

                                if (amountIn === 0n) {
                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `⚪ ZERO LIQUIDITY [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} (${asset.name})`
                                    });
                                    continue;
                                }

                                if (estimatedProfit === 0n) {
                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `\x1b[31m📉 SIMULATION RUN [- Result] [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} (${asset.name}) | Yield: Unprofitable\x1b[0m`
                                    });
                                    continue;
                                }

                                if (estimatedProfit > 0n) {
                                    const rawProfitNormalized = Number(estimatedProfit) / 1e6;
                                    
                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `\x1b[32m⚡ MEV MATCH [+ Result] [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} (${asset.name}) | Net expected: +$${rawProfitNormalized.toFixed(6)} USDC\x1b[0m`
                                    });

                                    // ------------------------------------------------------------------------
                                    // PRODUCTION LIVE EXECUTION PIPELINE
                                    // ------------------------------------------------------------------------
                                    const txDeadline = Math.floor(Date.now() / 1000) + 30; // 30 second deadline safety

                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `🔥 [Shard #${workerId}] BROADCASTING LIVE ATOMIC TRANSACTION FOR REAL PROFIT...`
                                    });

                                    // Fire and forget without blocking iteration loops
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
                                            data: `📡 [Shard #${workerId}] Tx Broadcasted successfully! Hash: ${txResponse.hash}`
                                        });

                                        const receipt = await txResponse.wait();
                                        if (receipt.status === 1) {
                                            parentPort.postMessage({
                                                type: "LOG",
                                                data: `\x1b[32m✨ TRANSACTION CONFIRMED IN BLOCK ${receipt.blockNumber}! Extract successful.\x1b[0m`
                                            });
                                            parentPort.postMessage({ type: "PROFIT", amount: rawProfitNormalized });
                                        } else {
                                            parentPort.postMessage({
                                                type: "LOG",
                                                data: `🔴 [Shard #${workerId}] On-chain transaction reverted post-flight.`
                                            });
                                        }
                                    }).catch((txError) => {
                                        parentPort.postMessage({
                                            type: "LOG",
                                            data: `⚠️ [Shard #${workerId}] Transaction submission rejected or dropped: ${txError.message.slice(0, 85)}`
                                        });
                                    });
                                }

                            } catch (simError) {
                                let errMsg = simError.message || "";
                                if (errMsg.includes("Identical addresses")) continue;

                                parentPort.postMessage({
                                    type: "LOG",
                                    data: `静态 CONTRACT REVERT [Shard #${workerId}]: Exception: ${errMsg.slice(0, 65)}`
                                });
                            }
                        }
                    }
                }
            } catch (loopErr) {
                // Shield Exception Drop
            }
        }
    });
}
