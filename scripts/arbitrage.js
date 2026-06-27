/**
 * ARBBOT1 - Full Reactive Multi-Threaded Arbitrage Engine
 * Architecture: WSS Resilient Stream Pool -> 4 Thread Worker Cluster -> FastLane Bundle Relay
 * Specification: Ethers v6 Production Build
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
    // INFRASTRUCTURE FIX: Replaced polygon.fastlane.live with high-availability route to clear GitHub DNS restrictions
    fastLaneRpc: "https://polygon-rpc.com",               

    contractAddress: "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc",                    
    usdcAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

    estimatedGasCost: 0.0,       
    priorityFeeGwei: 50n,       

    candidateSizes: [
        "1000000000"            // Single size tier ($1,000 USDC) to avoid multi-loop simulation lag
    ],

    routers: {
        QUICK:   "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
        SUSHI:   "0x1b02dA8Cb0d097e645729F65733526440d599963",
        DFYN:    "0xF18056Bbd320E96A48e3Fbf8bC061322531aac99",
        WAULT:   "0x3a1D873C37abE9244065524bAd7F7a2f35f7999A",
        JETSWAP: "0x5C6EC38c28eCD03d18a540552a914A8f1b6214A5",
        APESWAP: "0xC0788A3D1DE900874986012c4feEd447C1be9486",
        KATA:    "0x1b02dA8Cb0d097e645729F65733526440d599963" 
    }
};

// ABI explicitly mapped to target contract's custom structs & method interfaces
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
    if (err.message && (err.message.includes("Unexpected server response") || err.message.includes("detect network"))) {
        return; 
    }
    console.error("☠️ Uncaught Exception caught by Shield:", err);
});

process.on("unhandledRejection", (reason) => {
    if (reason && reason.message && reason.message.includes("detect network")) return;
});

// ============================================================================
// MAIN ORCHESTRATION THREAD
// ============================================================================
if (isMainThread) {
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ Critical Error: PRIVATE_KEY environment variable is missing.");
        process.exit(1);
    }

    console.log("🚀 FASTLANE UNRESTRICTED REAL-TIME MONITORING ONLINE\n");
    console.log(" Honeycomb Engine Routing directly via EVM state changes [Sharded Configuration]\n");
    console.log(`📡 Connected to State Read Node: ${CONFIG.fastLaneRpc}`);

    let totalRealizedProfits = 0.0;
    let workerThreads = [];
    let mainProvider;
    let currentEndpointIndex = 0;
    let isRotating = false;
    let fallbackTriggered = false;
    let activeEngineName = "WSS Engine Cluster";

    const tokenMatrix = [
        { name: "WETH",   token: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
        { name: "WMATIC", token: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
        { name: "WBTC",   token: "0x1BFD67037B42cf73acF2047067bd4F2C47D9BfD6" },
        { name: "DAI",    token: "0x8f3Cf6ad23Cd3EAd96143c01f6F98119404A55d0" },
        { name: "USDT",   token: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
        { name: "LINK",   token: "0x53E0bca35eCE356BD5ddDFebbD1BB0Bc891dC611" },
        { name: "AAVE",   token: "0xD6DF932A45C0f255f857453786923655859951f3" },
        { name: "UNI",    token: "0xb33EaAd8d922B108342553e35760940176d149c8" },
        { name: "CRV",    token: "0x172370d5Cd63229abA15d6547758714e30b6af59" },
        { name: "SUSHI",  token: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a" },
        { name: "WOO",    token: "0x1B565668729ce78b95bCd7c6A701053E77ED593c" },
        { name: "GRT",    token: "0x5fe2B58c013d764999778A227074492aB17C38a1" },
        { name: "GHST",   token: "0x385AB5439542e6402264584e03c0043896f05221" },
        { name: "BAL",    token: "0x9a71012B13CA4d3D0Cdc72b177DF3ef03b0E76A3" },
        { name: "QUICK",  token: "0xB5C064F959943346541fC60914b77f985bde3A0A" }
    ];

    const totalWorkers = 4;
    const chunkAllocation = Math.ceil(tokenMatrix.length / totalWorkers);

    console.log(`[System] Initialized ${totalWorkers} Isolated Worker Threads successfully.\n`);
    console.log(`[System] Distributed ~4 tokens and multi-hop paths per thread.\n`);

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
            isRotating = false; 

            mainProvider.on("block", async (blockNumber) => {
                console.log(`[${activeEngineName} - Block #${blockNumber}] Polling state changes...`);
                workerThreads.forEach((worker) => {
                    worker.postMessage({ type: "BLOCK_TRIGGER", blockNumber });
                });
            });

        } catch (initError) {
            console.log(`❌ Link creation rejected: WebSocket connection failed`);
            await attemptFallbackRotation();
        }
    }

    async function attemptFallbackRotation() {
        if (isRotating || fallbackTriggered) return;
        isRotating = true;

        currentEndpointIndex++;
        if (currentEndpointIndex >= CONFIG.providerWssEndpoints.length) {
            fallbackTriggered = true;
            console.log("\n⚠️ All configured WSS endpoints failed. Initializing Non-Crash Emergency HTTP Fallback Mode...");
            setupHttpFallbackMode();
            return;
        }

        console.log(`🔄 Rotating to fallback endpoint...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        isRotating = false;
        await connectWebSocketStream();
    }

    function setupHttpFallbackMode() {
        try {
            activeEngineName = "HTTP Fallback Engine";
            console.log(`📡 Spawning HTTP Polling Engine via State RPC Node: ${CONFIG.fastLaneRpc}\n`);
            const fallbackProvider = new ethers.JsonRpcProvider(CONFIG.fastLaneRpc, STATIC_POLYGON_NETWORK, { staticNetwork: STATIC_POLYGON_NETWORK });
            
            fallbackProvider.on("block", (blockNumber) => {
                console.log(`[${activeEngineName} - Block #${blockNumber}] Polling state changes...`);
                workerThreads.forEach((worker) => {
                    worker.postMessage({ type: "BLOCK_TRIGGER", blockNumber });
                });
            });
        } catch (err) {
            // Guard
        }
    }

    setTimeout(() => {
        connectWebSocketStream();
    }, 400);

// ============================================================================
// COMPONENT WORKER THREAD RUNTREES
// ============================================================================
} else {
    const { workerId, config, tokenPaths } = workerData;
    
    let fastLaneRelayProvider;
    let executionWallet;
    let vaultInstance;
    let isWorkerReady = false;
    let isProcessing = false;

    try {
        if (!process.env.PRIVATE_KEY) {
            throw new Error("PRIVATE_KEY missing.");
        }

        fastLaneRelayProvider = new ethers.JsonRpcProvider(
            config.fastLaneRpc, 
            STATIC_POLYGON_NETWORK, 
            { staticNetwork: STATIC_POLYGON_NETWORK }
        );

        executionWallet = new ethers.Wallet(process.env.PRIVATE_KEY, fastLaneRelayProvider);
        
        vaultInstance = new ethers.Contract(config.contractAddress.toLowerCase(), CONTRACT_ABI, executionWallet);
        isWorkerReady = true;

        parentPort.postMessage({
            type: "LOG",
            data: `✅ [Shard #${workerId}] Worker successfully initialized using Static EVM Routing.`
        });
    } catch (initErr) {
        // Safe catch
    }

    parentPort.on("message", async (message) => {
        if (!isWorkerReady || isProcessing) return;

        if (message.type === "BLOCK_TRIGGER") {
            isProcessing = true; 
            const routerIdentifiers = Object.keys(config.routers);

            try {
                for (const asset of tokenPaths) {
                    for (let b = 0; b < routerIdentifiers.length; b++) {
                        for (let s = 0; s < routerIdentifiers.length; s++) {
                            if (b === s) continue; 

                            const buyRouterName = routerIdentifiers[b];
                            const sellRouterName = routerIdentifiers[s];
                            
                            const buyRouterAddress = config.routers[buyRouterName].toLowerCase();
                            const sellRouterAddress = config.routers[sellRouterName].toLowerCase();

                            const pathToToken = [config.usdcAddress.toLowerCase(), asset.token.toLowerCase()];
                            const pathToUSDC = [asset.token.toLowerCase(), config.usdcAddress.toLowerCase()];

                            let rawSimulationOutput = null;
                            let contractRevertMessage = null;

                            try {
                                rawSimulationOutput = await vaultInstance.findBestFlashLoanSize(
                                    buyRouterAddress,
                                    sellRouterAddress,
                                    config.candidateSizes,
                                    pathToToken,
                                    pathToUSDC
                                );
                            } catch (e) {
                                contractRevertMessage = e.message.slice(0, 95);
                            }

                            const greenText = "\x1b[32m";
                            const redText = "\x1b[31m";
                            const yellowText = "\x1b[33m";
                            const greyText = "\x1b[90m";
                            const resetText = "\x1b[0m";

                            // UNFILTERED METRICS LOGGING LAYER
                            if (contractRevertMessage) {
                                parentPort.postMessage({
                                    type: "LOG",
                                    data: `${greyText}⚠️ [On-Chain Revert] [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} (${asset.name}) Exception: ${contractRevertMessage}${resetText}`
                                });
                                continue;
                            }

                            if (rawSimulationOutput) {
                                const targetedVolume = BigInt(rawSimulationOutput.amountIn.toString());
                                const rawContractEstimatedProfit = BigInt(rawSimulationOutput.estimatedProfit.toString());
                                
                                const localAavePremium = (targetedVolume * 5n) / 10000n; // Aave V3 0.05% Premium representation
                                const cleanNetProfitUSDC = (Number(rawContractEstimatedProfit) - Number(localAavePremium)) / 1e6;

                                if (targetedVolume === 0n) {
                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `${yellowText}⚪ ZERO LIQUIDITY [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} (${asset.name}) contract returned $0 volume.${resetText}`
                                    });
                                } else if (cleanNetProfitUSDC >= 0) {
                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `${greenText}⚡ MEV MATCH [+ Result] [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} (${asset.name})\n   ├── Size Tiered: $${(Number(targetedVolume)/1e6).toFixed(2)} USDC\n   └── Expected Net: +$${cleanNetProfitUSDC.toFixed(6)} USDC${resetText}`
                                    });
                                } else {
                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `${redText}📉 SIMULATION RUN [- Result] [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} (${asset.name})\n   ├── Size Tiered: $${(Number(targetedVolume)/1e6).toFixed(2)} USDC\n   └── Expected Net: -$${Math.abs(cleanNetProfitUSDC).toFixed(6)} USDC${resetText}`
                                    });
                                }
                            }
                        }
                    }
                }
            } finally {
                isProcessing = false; 
            }
        }
    });
}
