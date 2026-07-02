/**
 * ARBBOT1 - Dynamic Vault-Fund High-Velocity Execution Engine
 * Target: VaultArbitrageEnforcer (Capital-Adaptive Zero-Flash Architecture)
 * Edits: Dynamic Dry-Runs matching available on-chain contract liquidity
 */
import { ethers } from "ethers";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// COMPREHENSIVE GLOBAL CONFIGURATION & ADDRESS CACHE
// ============================================================================
const CONFIG = {
    providerWssEndpoints: [
        "wss://polygon-bor-rpc.publicnode.com",
        "wss://rpc-mainnet.matterlight.xyz/ws"
    ],
    fastLaneRpc: "https://polygon-bor-rpc.publicnode.com",
    fallbackRpc: "https://polygon.drpc.org",
    contractAddress: ethers.getAddress("0x7EAf60672b8C0A2399187bCA1bB916F14Ac7A958".toLowerCase()),
    vaultContractAddress: ethers.getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc".toLowerCase()),
    
    // Core Token Asset Matrix Cache
    tokens: {
        USDC:  ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()),
        USDCE: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()), 
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
    minSaneAllocation: 10000n,    // Absolute baseline to evaluate ($0.01 USDC) to filter empty dust pools
    gasLimitOverride: 850000n,    
    priorityFeeGwei: 45n,
    deadlineSeconds: 45               
};

const CONTRACT_ABI = [
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function minimumProfitUSDC() external view returns (uint256)"
];

const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];
const STATIC_POLYGON_NETWORK = ethers.Network.from({ name: "polygon", chainId: 137 });

// ============================================================================
// MAIN ORCHESTRATION ENGINE (COORDINATOR THREAD)
// ============================================================================
if (isMainThread) {
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ Critical Error: PRIVATE_KEY environment variable is missing.");
        process.exit(1);
    }

    console.log("🚀 PRODUCTION RUNNER STARTING: DYNAMIC LIQUIDITY ADAPTIVE MODEL");  
    console.log(`📡 Target RPC Endpoint: ${CONFIG.fastLaneRpc}`);  
    
    let totalRawProfits = 0.0;  
    let workerThreads = [];  
    let mainProvider;  
    let currentLocalNonce = null;

    const tempProvider = new ethers.JsonRpcProvider(CONFIG.fastLaneRpc, STATIC_POLYGON_NETWORK);
    const mainWallet = new ethers.Wallet(process.env.PRIVATE_KEY, tempProvider);
    const usdcContract = new ethers.Contract(CONFIG.tokens.USDC, ERC20_ABI, tempProvider);

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
                totalRawProfits += msg.amount;  
                console.log(`💰 Combined Metric Realized Raw Capture: +${totalRawProfits.toFixed(6)} USDC`);  
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
                let vaultBalance = 0n;
                try {
                    // Pull real-time available pool liquidity dynamically per block 
                    vaultBalance = await usdcContract.balanceOf(CONFIG.vaultContractAddress);
                    currentLocalNonce = await tempProvider.getTransactionCount(mainWallet.address, "pending");
                } catch (_) {}
                
                console.log(`\n[WebSocket Stream] 🔍 Block #${blockNumber} | Active Vault Capital Allocation: ${ethers.formatUnits(vaultBalance, 6)} USDC`);
                
                // Pass dynamic block allocation directly down to shards for execution dry-runs
                workerThreads.forEach(w => w.postMessage({ type: "BLOCK_TRIGGER", blockNumber, currentBalance: vaultBalance.toString() }));  
            });  
        } catch (_) {
            setupHttpFallbackMode();
        }  
    }  

    function setupHttpFallbackMode() {  
        const fallbackProvider = new ethers.JsonRpcProvider(CONFIG.fallbackRpc, STATIC_POLYGON_NETWORK);  
        fallbackProvider.on("block", async (blockNumber) => {  
            let vaultBalance = 0n;
            try {
                vaultBalance = await usdcContract.balanceOf(CONFIG.vaultContractAddress);
                currentLocalNonce = await fallbackProvider.getTransactionCount(mainWallet.address, "pending");
            } catch (_) {}
            
            console.log(`\n[HTTP Fallback Engine] 🔍 Block #${blockNumber} | Active Vault Capital Allocation: ${ethers.formatUnits(vaultBalance, 6)} USDC`);
            workerThreads.forEach(w => w.postMessage({ type: "BLOCK_TRIGGER", blockNumber, currentBalance: vaultBalance.toString() }));  
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
            const currentBalance = BigInt(message.currentBalance || "0");

            // Filter out tracking updates if contract has completely zero assets
            if (currentBalance < config.minSaneAllocation) {
                parentPort.postMessage({  
                    type: "LOG",  
                    data: `⚠️  [Shard #${workerId} Skip] Vault funds too low for dry-run calculations (${ethers.formatUnits(currentBalance, 6)} USDC)`  
                });  
                return;
            }

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

                // --- ADJUSTED LIVE LIQUIDITY DRY RUN ---
                // Simulating with exact variable dynamic vault balance parameter
                const [result3Hop, result4Hop, minProfitUSDC] = await Promise.all([
                    contractInstance.simulateArbitrageProfit(routerA, routerB, currentBalance, path3ToToken, path3ToUSDC).catch(() => [0n, 0n]),
                    contractInstance.simulateArbitrageProfit(routerA, routerB, currentBalance, path4ToToken, path4ToUSDC).catch(() => [0n, 0n]),
                    contractInstance.minimumProfitUSDC()
                ]);

                let selectedProfit = 0n;
                let finalBuyPath = [];
                let finalSellPath = [];

                if (result3Hop[1] >= minProfitUSDC && result3Hop[1] >= result4Hop[1]) {
                    selectedProfit = result3Hop[1];
                    finalBuyPath = path3ToToken;
                    finalSellPath = path3ToUSDC;
                } else if (result4Hop[1] >= minProfitUSDC) {
                    selectedProfit = result4Hop[1];
                    finalBuyPath = path4ToToken;
                    finalSellPath = path4ToUSDC;
                }

                // If dry run confirms a valid arbitrage gap matching on-chain balance targets
                if (selectedProfit >= minProfitUSDC) {
                    const rawProfitStr = ethers.formatUnits(selectedProfit, 6);
                    
                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `🔥 DYNAMIC DRY RUN HIT [Shard #${workerId}]: Size: ${ethers.formatUnits(currentBalance, 6)} USDC | Raw Profit Delta: +${rawProfitStr} USDC`  
                    });  

                    const assignedNonce = await new Promise((resolve) => {
                        pendingTxPromiseResolver = resolve;
                        parentPort.postMessage({ type: "REQUEST_NONCE" });
                    });

                    const feeData = await provider.getFeeData();  
                    const currentBaseFee = feeData.estimatedBaseFee || 180000000000n;  
                    const maxPriorityFee = ethers.parseUnits(config.priorityFeeGwei.toString(), "gwei");

                    const txDeadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;  
                    const batchPayload = { 
                        buyRouters: [routerA], 
                        sellRouters: [routerB], 
                        amountsInUSDC: [currentBalance], 
                        pathsToToken: [finalBuyPath], 
                        pathsToUSDC: [finalSellPath], 
                        deadline: txDeadline 
                    };

                    const txResponse = await contractInstance.executeFlashBatchArbitrage(batchPayload, {
                        nonce: assignedNonce,
                        gasLimit: config.gasLimitOverride,
                        maxFeePerGas: (currentBaseFee * 2n) + maxPriorityFee,
                        maxPriorityFeePerGas: maxPriorityFee
                    });

                    parentPort.postMessage({  
                        type: "LOG",  
                        data: `📡 DISPATCHING LIVE VAULT TX: ${txResponse.hash}`  
                    });  

                    const receipt = await txResponse.wait(1);  

                    if (receipt.status === 1) {
                        parentPort.postMessage({ type: "LOG", data: `✨ TRANSACTION SETTLED` });
                        parentPort.postMessage({ type: "PROFIT", amount: parseFloat(rawProfitStr) });
                    } else {
                        parentPort.postMessage({ type: "LOG", data: `❌ Execution Dropped Post-Mempool (Slippage Safe Mode Protected Vault Balance)` });
                    }
                } else {
                    parentPort.postMessage({ type: "LOG", data: `📡 Shard #${workerId} Dry-Run Check: Route monitored, no raw yield discovered this block.` });
                }
            } catch (err) {  
                parentPort.postMessage({  
                    type: "LOG",  
                    data: `❌ Evaluation Pipeline Fault: ${err.reason || err.message}`  
                });
            }  
        }  
    });
}
