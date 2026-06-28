/**
 * ARBBOT1 - High-Velocity Instant Pipeline Verification Engine (FIXED)
 * Architecture: WSS Resilient Stream Pool -> Multi-Thread Worker Cluster -> FastLane Bundle Relay
 * Specification: Ethers v6 Production Build
 * Mode: Instant Trigger Execution Mode (Zero Re-validation / Maximum Concurrency Ceiling)
 * Structure: USDC -> [Target Asset] -> USDC (Clean Triangular Execution)
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
    
    // FIX 2: Tuned sizes using correct 6-decimal scaling to clear liquidity fees
    candidateSizes: [
        "10000000",   // $10.00 USDC
        "100000000",  // $100.00 USDC
        "500000000"   // $500.00 USDC
    ],
    routers: {
        QUICK:   ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7a678ff".toLowerCase()),
        SUSHI:   ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase()),
        DFYN:    ethers.getAddress("0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429".toLowerCase()),
        WAULT:   ethers.getAddress("0xa98ea6356a4ff7b427969ddf5da3627d6aeae9a4".toLowerCase()), 
        APESWAP: ethers.getAddress("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607".toLowerCase()),
        FIREBIRD:ethers.getAddress("0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA".toLowerCase())
    },
    immediateExecution: true,
    revalidateBeforeSend: false,      
    executeOnFirstProfit: true,       
    maxPendingTransactions: 1,        
    blockConfirmConfirmations: 1,      
    deadlineSeconds: 30               
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

    console.log("⚡ INSTANT HIGH-VELOCITY REACTION RUNNER ONLINE\n");  
    console.log(`📡 Target Node Endpoint: ${CONFIG.fastLaneRpc}`);  
    console.log(`🔧 Concurrency Cap: Exactly ${CONFIG.maxPendingTransactions} Flight Multi-Tx Allowed\n`);

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
        { name: "WETH",     token: ethers.getAddress("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619".toLowerCase()) },
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
                console.log(`💰 Verified Pipeline Balance Accumulated: ${totalRealizedProfits.toFixed(6)} USDC`);  
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
            console.log(`  🚀 HIGH-VELOCITY MODE ENGAGED: NO REVALIDATION DETOURS   `);  
            console.log(`  ├── Concurrency Cap        ● ${CONFIG.maxPendingTransactions} Max Flight Tx            `);  
            console.log(`  ├── Block Confirmation Cap  ● Set to ${CONFIG.blockConfirmConfirmations} Confirmation     `);  
            console.log(`  └── Engine Loop Optimization● Immediate Gross-Fire Enabled`);  
            console.log(`═══════════════════════════════════════════════════════════\n`);  
            isRotating = false;   
            mainProvider.on("block", async (blockNumber) => {  
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
            const routerIdentifiers = Object.keys(config.routers);  
            
            if (pendingTransactionsCount >= config.maxPendingTransactions) {
                return; 
            }

            try {  
                const feeData = await fastLaneRelayProvider.getFeeData();  
                const currentBaseFee = feeData.estimatedBaseFee || 0n;  
                const calculatedMaxPriority = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");  
                const calculatedMaxFee = (currentBaseFee * 2n) + calculatedMaxPriority;  
                
                // FIX 3: Removed the 'if' condition that explicitly locked out high-volume core assets (WMATIC, WETH, USDT, DAI)

                for (let b = 0; b < routerIdentifiers.length; b++) {  
                    for (let s = 0; s < routerIdentifiers.length; s++) {  
                        if (b === s) continue; // Skip matching identical routers
                        if (pendingTransactionsCount >= config.maxPendingTransactions) break;

                        const buyRouterName = routerIdentifiers[b];  
                        const sellRouterName = routerIdentifiers[s];  
                        const buyRouterAddress = config.routers[buyRouterName];  
                        const sellRouterAddress = config.routers[sellRouterName];  
                        
                        // FIX 1: Path layout simplified to a standard liquid triangular loop (USDC -> Asset -> USDC)
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

                            if (amountIn === 0n || estimatedFinalUSDC === 0n) continue;   

                            if (estimatedFinalUSDC >= (amountIn + 1n)) {  
                                const rawProfitNormalized = Number(estimatedFinalUSDC - amountIn) / 1e6;  
                                
                                pendingTransactionsCount++;

                                parentPort.postMessage({  
                                    type: "LOG",  
                                    data: `\x1b[35m⚡ pipeline instant-fire [Shard #${workerId}]: ${buyRouterName} ➔ ${sellRouterName} | Gross variance: +$${rawProfitNormalized.toFixed(6)} USDC\x1b[0m`  
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
                                            data: `✨ SUCCESS! Pipeline verified in block ${receipt.blockNumber}.`  
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
                            // Silent fallback step for failing layout structures
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
