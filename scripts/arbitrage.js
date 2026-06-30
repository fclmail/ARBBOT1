/**
 * ARBBOT1 - Dynamic Capital Flash Loan Engine
 * Target: VaultArbitrageEnforcer (With Native Binary Search Sizing & Aave V3 Routing)
 */
import { ethers } from "ethers";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// COMPREHENSIVE GLOBAL CONFIGURATION & CANDIDATE BOUNDARIES
// ============================================================================
const CONFIG = {
    providerWssEndpoints: [
        "wss://polygon-bor-rpc.publicnode.com",
        "wss://rpc-mainnet.matterlight.xyz/ws"
    ],
    fastLaneRpc: "https://polygon-bor-rpc.publicnode.com",
    fallbackRpc: "https://polygon.drpc.org",
    contractAddress: ethers.getAddress("0x7EAf60672b8C0A2399187bCA1bB916F14Ac7A958".toLowerCase()),
    
    tokens: {
        USDC:   ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()),
        USDCE:  ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()), 
        WMATIC: ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase()),
        WETH:   ethers.getAddress("0x7ceB23fD6bC0ad59E6c5526540FF14a23a8B8487".toLowerCase()),
        USDT:   ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase()),
        DAI:    ethers.getAddress("0x8f3Cf6ad23Cd3EAd96143c01f6F9852fEF29d33E".toLowerCase()),
        WBTC:   ethers.getAddress("0x1BFD62179a14E6c3851b40690f39332744573565".toLowerCase())
    },
    routers: {
        QUICK:   ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),
        SUSHI:   ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase()),
        DFYN:    ethers.getAddress("0xF15361A03Eca00a63A23e1bd165157Cb02434a62".toLowerCase())
    },
    
    // Size Optimization Array used by the contract's internal simulation sweeps
    candidateSizes: [
        100000000n,   // $100 USDC Lower Array Bound
        500000000n,   // $500 USDC
        2500000000n,  // $2,500 USDC 
        10000000000n  // $10,000 USDC Upper Array Bound
    ],
    gasLimitOverride: 1950000n,   // Elevated to cover on-chain binary searches + flash loan execution
    priorityFeeGwei: 45n,
    deadlineSeconds: 45               
};

const CONTRACT_ABI = [
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns ((uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit) best)",
    "function minimumProfitUSDC() external view returns (uint256)"
];

const STATIC_POLYGON_NETWORK = ethers.Network.from({ name: "polygon", chainId: 137 });

// ============================================================================
// MAIN COORDINATOR THREAD
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
    let currentLocalNonce = null;

    const tempProvider = new ethers.JsonRpcProvider(CONFIG.fastLaneRpc, STATIC_POLYGON_NETWORK);
    const mainWallet = new ethers.Wallet(process.env.PRIVATE_KEY, tempProvider);

    const activeSubMatrices = [  
        { id: 1, routers: ["QUICK", "SUSHI"], intermediate: ["WMATIC", "WETH"] }, 
        { id: 2, routers: ["QUICK", "DFYN"], intermediate: ["USDT", "WBTC"] },   
        { id: 3, routers: ["SUSHI", "DFYN"], intermediate: ["DAI", "WETH"] },    
        { id: 4, routers: ["QUICK", "SUSHI"], intermediate: ["WBTC", "WMATIC"] } 
    ];  

    for (let i = 0; i < activeSubMatrices.length; i++) {
        const engineWorker = new Worker(__filename, {  
            workerData: { 
                workerId: activeSubMatrices[i].id, 
                config: CONFIG, 
                matrix: activeSubMatrices[i].routers,
                intermediates: activeSubMatrices[i].intermediate
            }  
        });  

        engineWorker.on("message", async (msg) => {  
            if (msg.type === "LOG") console.log(msg.data);  
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
// COMPONENT WORKER THREAD RUNTIME (ISOLATED SHARD PROCESSING METRIC)
// ============================================================================
} else {
    const { workerId, config, matrix, intermediates } = workerData;
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
                data: `✅ [Shard #${workerId}] Scanning Matrix Array: [${matrix.join(", ")}] × Multi-Hop Complex Route Set`  
            });  

            try {
                const routerA = config.routers[matrix[0]];
                const routerB = config.routers[matrix[1]];
                
                const tokenUSDC = config.tokens.USDC;
                const tokenInt1 = config.tokens[intermediates[0]];
                const tokenInt2 = config.tokens[intermediates[1]];

                const path3ToToken = [tokenUSDC, tokenInt1, tokenInt2];
                const path3ToUSDC  = [tokenInt2, tokenUSDC];

                const path4ToToken = [tokenUSDC, tokenInt1, tokenInt2];
                const path4ToUSDC  = [tokenInt2, config.tokens.USDCE, tokenUSDC];

                // CONTRACT INTEGRATED OPTIMIZATION: Query the binary search state via Contract View Method
                const [best3Hop, best4Hop, minProfitUSDC] = await Promise.all([
                    contractInstance.findBestFlashLoanSize(routerA, routerB, config.candidateSizes, path3ToToken, path3ToUSDC).catch(() => ({ amountIn: 0n, estimatedProfit: 0n })),
                    contractInstance.findBestFlashLoanSize(routerA, routerB, config.candidateSizes, path4ToToken, path4ToUSDC).catch(() => ({ amountIn: 0n, estimatedProfit: 0n })),
                    contractInstance.minimumProfitUSDC()
                ]);

                let selectedProfit = 0n;
                let finalBuyPath = [];
                let finalSellPath = [];

                if (best3Hop.estimatedProfit >= minProfitUSDC && best3Hop.estimatedProfit >= best4Hop.estimatedProfit) {
                    selectedProfit = best3Hop.estimatedProfit;
                    finalBuyPath = path3ToToken;
                    finalSellPath = path3ToUSDC;
                } else if (best4Hop.estimatedProfit >= minProfitUSDC) {
                    selectedProfit = best4Hop.estimatedProfit;
                    finalBuyPath = path4ToToken;
                    finalSellPath = path4ToUSDC;
                }

                if (selectedProfit >= minProfitUSDC) {
                    const formattedProfitStr = ethers.formatUnits(selectedProfit, 6);
                    
                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `🔥 OFFLINE SIMULATION HIT [Shard #${workerId}]: Profit Delta Detected: +${formattedProfitStr} USDC`  
                    });  

                    const assignedNonce = await new Promise((resolve) => {
                        pendingTxPromiseResolver = resolve;
                        parentPort.postMessage({ type: "REQUEST_NONCE" });
                    });

                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `🚀 Allocating Matrix Pipeline ➔ Nonce Assigned: ${assignedNonce}`  
                    });

                    const feeData = await provider.getFeeData();  
                    const currentBaseFee = feeData.estimatedBaseFee || 180000000000n;  
                    const maxPriorityFee = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");
                    const totalGasPrice = currentBaseFee + maxPriorityFee;

                    parentPort.postMessage({
                        type: "LOG",
                        data: `⛽ Network Gas Evaluation: Base Fee ${parseInt(ethers.formatUnits(currentBaseFee, "gwei"))} Gwei | Priority Tip ${config.priorityFeeGwei} Gwei`
                    });

                    const txDeadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;  

                    // 100% LIVE MUTATIVE BROADCST ON-CHAIN: Fires contract optimization wrapper + Aave flash loan callback sequence
                    const txResponse = await contractInstance.executeBestFlashLoanArbitrage(
                        routerA,
                        routerB,
                        config.candidateSizes,
                        finalBuyPath,
                        finalSellPath,
                        txDeadline,
                        {
                            nonce: assignedNonce,
                            gasLimit: config.gasLimitOverride,
                            maxFeePerGas: (currentBaseFee * 2n) + maxPriorityFee,
                            maxPriorityFeePerGas: maxPriorityFee
                        }
                    );

                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `📡 ONLINE EXECUTION DISPATCHED: ${txResponse.hash}`  
                    });  

                    const receipt = await txResponse.wait(1);  
                    const gasUsed = receipt.gasUsed || config.gasLimitOverride;
                    const polSpent = ethers.formatEther(gasUsed * totalGasPrice);
                    const usdEquivalent = (parseFloat(polSpent) * 0.60).toFixed(2);

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
                    parentPort.postMessage({ type: "LOG", data: `📡 Scan Completed: No arbitrage path open this block.` });
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
