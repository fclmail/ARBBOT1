/**
 * ARBBOT1 - High-Velocity Instant Pipeline Verification Engine
 * Architecture: WSS Resilient Stream Pool -> Multi-Thread Worker Cluster -> FastLane Bundle Relay
 * Specification: Ethers v6 Production Build
 * Mode: FORCED LIFELINE MODE (Guaranteed Pool Paths for Immediate Live Broadcast)
 * Structure: USDC -> WETH -> WMATIC -> USDC
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
    fastLaneRpc: "https://polygon-bor-rpc.publicnode.com",
    fallbackRpc: "https://polygon.drpc.org",
    contractAddress: ethers.getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc".toLowerCase()),
    usdcAddress: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()),
    gasLimitOverride: 750000n,
    priorityFeeGwei: 45n,
    candidateSizes: [
        "20000"                // $0.02 USDC trade size alignment
    ],
    // STREAMLINED TO HIGH-VOLUME ROUTERS TO ELIMINATE RPC RATE LIMITS
    routers: {
        QUICK:   ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),
        SUSHI:   ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase())
    },
    // ULTRA-AGGRESSIVE VERIFICATION FLAGS
    immediateExecution: true,
    revalidateBeforeSend: false,      // Bypasses extra gas/simulation logic overhead
    executeOnFirstProfit: true,       // Fires the exact block instant criteria hits
    maxPendingTransactions: 1,        // Strictly prevents execution overlap / nonce locking
    blockConfirmConfirmations: 1,      // Drops thread blocking after the first target receipt
    deadlineSeconds: 30               // Short window transaction death-drop protection
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

// Global Shield against standard socket disconnection noise
process.on("uncaughtException", (err) => {
    if (err.message && (err.message.includes("Unexpected server response") || err.message.includes("detect network") || err.message.includes("ENOTFOUND") || err.message.includes("websocket"))) return;
    console.error("☠️ System Shield intercepted exception:", err);
});
process.on("unhandledRejection", (reason) => {
    if (reason && reason.message && (reason.message.includes("detect network") || reason.message.includes("ENOTFOUND") || reason.message.includes("websocket"))) return;
});

// ============================================================================
// MAIN ORCHESTRATION THREAD
// ============================================================================
if (isMainThread) {
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ Critical Error: PRIVATE_KEY environment variable is missing.");
        process.exit(1);
    }

    console.log("⚠️ WARNING: FORCED VERIFICATION MODE ACTIVE ⚠️");  
    console.log(" Script will fire real transactions on ANY valid pool response.\n");  
    console.log(`📡 Target Node Endpoint: ${CONFIG.fastLaneRpc}`);  

    let totalRealizedProfits = 0.0;  
    let workerThreads = [];  
    let mainProvider;  
    let currentEndpointIndex = 0;  
    let isRotating = false;  
    let fallbackTriggered = false;  
    let activeEngineName = "WebSocket Stream Cluster";  

    const coreBridges = [  
        { name: "WMATIC",   token: ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase()) },  
        { name: "USDT",     token: ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase()) },  
        { name: "DAI",      token: ethers.getAddress("0x8f3cf7ad23cd3cadbd9735aff958023239c6a063".toLowerCase()) },  
        { name: "AAVE",     token: ethers.getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b".toLowerCase()) },
        { name: "CRV",      token: ethers.getAddress("0x172370d5cd63279efa6d502dab29171933a610af".toLowerCase()) },
        { name: "QUICK",    token: ethers.getAddress("0x831753dd7087cac61ab5644b308642cc1c33dc13".toLowerCase()) },
        { name: "APE",      token: ethers.getAddress("0x4d224452801aced8b2f0aebe155379bb5d594381".toLowerCase()) },
        { name: "LINK",     token: ethers.getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39".toLowerCase()) },
        { name: "SHIB",     token: ethers.getAddress("0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0".toLowerCase()) },
        { name: "UNI",      token: ethers.getAddress("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984".toLowerCase()) },
        { name: "WBTC",     token: ethers.getAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6".toLowerCase()) },
        { name: "BAT",      token: ethers.getAddress("0x3cef98bb43d732e2f285ee605a8158cde967d219".toLowerCase()) },
        { name: "TBTC",     token: ethers.getAddress("0x236aa50979d5f3de3bd1eeb40e81137f22ab794b".toLowerCase()) },
        { name: "MANA",     token: ethers.getAddress("0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4".toLowerCase()) },
        { name: "TRB",      token: ethers.getAddress("0xe3322702bedaaed36cddab233360b939775ae5f1".toLowerCase()) },
        { name: "COMP",     token: ethers.getAddress("0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c".toLowerCase()) },
        { name: "INCH",     token: ethers.getAddress("0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f".toLowerCase()) },
        { name: "THETA",    token: ethers.getAddress("0xb46e0ae620efd98516f49bb00263317096c114b2".toLowerCase()) },
        { name: "CRO",      token: ethers.getAddress("0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c".toLowerCase()) },
        { name: "XYO",      token: ethers.getAddress("0xd2507e7b5794179380673870d88b22f94da6abe0".toLowerCase()) },
        { name: "MASK",     token: ethers.getAddress("0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7".toLowerCase()) },
        { name: "EURQ",     token: ethers.getAddress("0xd571edb2ef29df10fcd6200fd6d0ed2389983db3".toLowerCase()) },
        { name: "APOLUSDT", token: ethers.getAddress("0x6ab707aca953edaefbc4fd23ba73294241490620".toLowerCase()) },
        { name: "ENJ",      token: ethers.getAddress("0x7ec26842f195c852fa843bb9f6d8b583a274a157".toLowerCase()) },
        { name: "ZRX",      token: ethers.getAddress("0x5559edb74751a0ede9dea4dc23aee72cca6be3d5".toLowerCase()) },
        { name: "GMT",      token: ethers.getAddress("0x714db550b574b3e927af3d93e26127d15721d4c2".toLowerCase()) },
        { name: "SNX",      token: ethers.getAddress("0x50b728d8d964fd00c2d0aad81718b71311fef68a".toLowerCase()) },
        { name: "ANKR",     token: ethers.getAddress("0x101a023270368c0d50bffb62780f4afd4ea79c35".toLowerCase()) },
        { name: "GLM",      token: ethers.getAddress("0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf".toLowerCase()) },
        { name: "COW",      token: ethers.getAddress("0x2f4efd3aa42e15a1ec6114547151b63ee5d39958".toLowerCase()) },
        { name: "BAND",     token: ethers.getAddress("0xa8b1e0764f85f53dfe21760e8afe5446d82606ac".toLowerCase()) },
        { name: "AXL",      token: ethers.getAddress("0x6e4e624106cb12e168e6533f8ec7c82263358940".toLowerCase()) },
        { name: "UMA",      token: ethers.getAddress("0x3066818837c5e6ed6601bd5a91b0762877a6b731".toLowerCase()) },
        { name: "YFI",      token: ethers.getAddress("0xda537104d6a5edd53c6fbba9a898708e465260b6".toLowerCase()) },
        { name: "ELON",     token: ethers.getAddress("0xe0339c80ffde91f3e20494df88d4206d86024cdf".toLowerCase()) },
        { name: "NEXO",     token: ethers.getAddress("0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e".toLowerCase()) }
    ];  

    const totalWorkers = coreBridges.length;  

    for (let i = 0; i < totalWorkers; i++) {  
        const engineWorker = new Worker(__filename, {  
            workerData: { workerId: i + 1, config: CONFIG, primaryAsset: coreBridges[i], allBridges: coreBridges }  
        });  

        engineWorker.on("message", (msg) => {  
            if (msg.type === "LOG") {  
                console.log(msg.data);  
            } else if (msg.type === "PROFIT") {  
                totalRealizedProfits += msg.amount;  
                console.log(`💰 Pipeline Verified Counter: ${totalRealizedProfits.toFixed(6)} USDC`);  
            }  
        });  

        workerThreads.push(engineWorker);  
    }  

    async function connectWebSocketStream() {  
        if (fallbackTriggered) return;  
        const targetEndpoint = CONFIG.providerWssEndpoints[currentEndpointIndex];  
          
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
              
            console.log(`\n═══════════════════════════════════════════════════════════`);  
            console.log(`  🚀 VERIFICATION ACTIVE: DEEP LIQUIDITY COMPRESSION LIVE  `);  
            console.log(`  ├── Concurrency Cap         ● ${CONFIG.maxPendingTransactions} Max Flight Tx            `);  
            console.log(`  └── Route Path Guarantee    ● USDC ➔ WETH ➔ WMATIC ➔ USDC`);  
            console.log(`═══════════════════════════════════════════════════════════\n`);  

            isRotating = false;   
            mainProvider.on("block", async (blockNumber) => {  
                console.log(`[${activeEngineName}] 🔍 Scanning Block #${blockNumber} Across All Shards...`);
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
                console.log(`[${activeEngineName}] 🔍 Scanning Block #${blockNumber}...`);
                workerThreads.forEach((worker) => {  
                    worker.postMessage({ type: "BLOCK_TRIGGER", blockNumber });  
                });  
            });  
        } catch (err) {}  
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

    parentPort.postMessage({  
        type: "LOG",  
        data: `✅ [Shard #${workerId}] Instant Scan Path Active. Vector: ${primaryAsset.name}`  
    });  

    parentPort.on("message", async (message) => {  
        if (message.type === "BLOCK_TRIGGER") {  
            const currentBlockNum = message.blockNumber;  
            const routerIdentifiers = Object.keys(config.routers);  

            if (pendingTransactionsCount >= config.maxPendingTransactions) {
                return; 
            }

            try {  
                const feeData = await fastLaneRelayProvider.getFeeData();  
                const currentBaseFee = feeData.estimatedBaseFee || 0n;  
                const calculatedMaxPriority = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");  
                const calculatedMaxFee = (currentBaseFee * 2n) + calculatedMaxPriority;  

                // DEEP BLUECHIP ANCHORS DEFINED FOR POOL LIFELINE
                const wmatic = ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase());
                const weth   = ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase());

                for (let b = 0; b < routerIdentifiers.length; b++) {  
                    for (let s = 0; s < routerIdentifiers.length; s++) {  
                        
                        if (pendingTransactionsCount >= config.maxPendingTransactions) break;

                        const buyRouterName = routerIdentifiers[b];  
                        const sellRouterName = routerIdentifiers[s];  
                        const buyRouterAddress = config.routers[buyRouterName];  
                        const sellRouterAddress = config.routers[sellRouterName];  

                        // VERIFICATION RE-ROUTE: Forced through WETH/WMATIC guaranteed pool venues
                        const pathToToken = [config.usdcAddress, weth, wmatic];  
                        const pathToUSDC = [wmatic, config.usdcAddress];  

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

                            if (amountIn === 0n || estimatedFinalUSDC === 0n) continue;   

                            // VERIFICATION SETTING: Fires the transaction on ANY valid mathematical output pool response (> 0)
                            if (estimatedFinalUSDC > 0n) {  
                                const rawProfitNormalized = Number(estimatedFinalUSDC - amountIn) / 1e6;  
                                
                                pendingTransactionsCount++;

                                parentPort.postMessage({  
                                    type: "LOG",  
                                    data: `\x1b[35m⚡ Pipeline Instant-Fire [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} | Output verified: ${estimatedFinalUSDC.toString()} micro-units\x1b[0m`  
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
                                        data: `🚀 Pipeline Flight Sent. Hash: ${txResponse.hash}`  
                                    });  

                                    const receipt = await txResponse.wait(config.blockConfirmConfirmations);  
                                    pendingTransactionsCount--; 

                                    if (receipt.status === 1) {  
                                        parentPort.postMessage({  
                                            type: "LOG",  
                                            data: `✨ SUCCESS! Pipeline execution confirmed in block ${receipt.blockNumber}.`  
                                        });  
                                        parentPort.postMessage({ type: "PROFIT", amount: rawProfitNormalized });  
                                    } else {  
                                        parentPort.postMessage({  
                                            type: "LOG",  
                                            data: `🔴 On-chain Reverted Receipt for transaction: ${txResponse.hash}`  
                                        });  
                                    }  
                                }).catch((txError) => {  
                                    pendingTransactionsCount--;  
                                    parentPort.postMessage({  
                                        type: "LOG",  
                                        data: `⚠️ Dispatch Failure on Network Core: ${txError.message}`  
                                    });  
                                });

                                if (config.executeOnFirstProfit) break;
                            }  
                        } catch (simError) {  
                            // Silent fallback context for failing AMM pathways  
                        }  
                    }  
                    if (config.executeOnFirstProfit && pendingTransactionsCount >= config.maxPendingTransactions) break;
                }
            } catch (err) {  
                // Silent catch fallback for gas calculation issues
            }  
        }  
    });  
}
