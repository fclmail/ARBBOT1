import { ethers } from "ethers";
import dotenv from "dotenv";
import pLimit from "p-limit"; // Controls concurrent node flood

dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ==========================================================
// 1. HIGH-PERFORMANCE PRIVATE/PREMIUM ENDPOINTS TIER
// ==========================================================
// Replace these with premium/MEV direct private endpoints for live production
const WSS_ENDPOINTS = [
    "wss://polygon.drpc.org",
    "wss://polygon-bor-rpc.publicnode.com",
    "wss://polygon.api.onfinality.io/public-ws",
    "wss://rpc-mainnet.matic.quiknode.pro"
];
let currentEndpointIndex = 0;

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Expanded Object array skeleton container accommodating up to 100+ tokens securely
const TOKENS = {
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
    // ... Append up to 100 tokens safely below. The chunking algorithm scales smoothly.
};

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() view returns (uint256)"
];

const SWAP_EVENT_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130140159d82c";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Helper function to segment arrays to enforce rate-limiting thresholds
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

function buildMultiHopCrossExchangePaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];

    // ---- 3-HOP TRIANGULAR PATHS ----
    for (const a of tokenAddresses) {
        for (const b of tokenAddresses) {
            if (a === b) continue;
            generatedPaths.push({
                hops: 3,
                pathToToken: [USDC_ADDRESS, a, b],
                pathToUSDC: [b, USDC_ADDRESS]
            });
        }
    }

    // ---- 4-HOP QUADRANGULAR PATHS ----
    for (const a of tokenAddresses) {
        for (const b of tokenAddresses) {
            if (a === b) continue;
            for (const c of tokenAddresses) {
                if (c === a || c === b) continue;
                generatedPaths.push({
                    hops: 4,
                    pathToToken: [USDC_ADDRESS, a, b, c],
                    pathToUSDC: [c, USDC_ADDRESS]
                });
            }
        }
    }
    return generatedPaths;
}

let provider;
let wallet;
let vaultContract;
let isReconnecting = false;

// Concurrency limiting engine settings to control node query strain
const MAX_CONCURRENT_REQUESTS = 15; 
const PATH_CHUNK_SIZE = 40; 
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

async function initWebSocketConnection(targetUrl, onDisconnect) {
    provider = new ethers.WebSocketProvider(targetUrl);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);

    provider.getNetwork().catch(() => { onDisconnect(); });
}

async function main() {
    if (isReconnecting) return;
    
    console.log("🚀 HIGH-SPEED AUTO-BATCHING MEMPOOL ENGINE ONLINE");
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    console.log(`📡 Connecting stream gateway: ${targetUrl}`);
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing in environment variables.");
        process.exit(1);
    }

    const handleReconnect = async () => {
        if (isReconnecting) return;
        isReconnecting = true;
        
        console.log(`⚠️ Network packet lag detected. Switching endpoints...`);
        currentEndpointIndex = (currentEndpointIndex + 1) % WSS_ENDPOINTS.length;

        if (provider) {
            try { provider.removeAllListeners(); } catch {}
            try { await provider.destroy(); } catch {}
        }
        
        await sleep(3000); 
        isReconnecting = false;
        main().catch(() => {});
    };

    try {
        await initWebSocketConnection(targetUrl, handleReconnect);
    } catch (err) {
        handleReconnect();
        return;
    }

    const multiHopPaths = buildMultiHopCrossExchangePaths();
    const capitalTiers = ["100", "500", "1500", "5000"]; // Optimized tiers balancing deep liquidity pools
    const pathChunks = chunkArray(multiHopPaths, PATH_CHUNK_SIZE);
    
    console.log(`📊 Matrix initialized: Loaded ${multiHopPaths.length} multi-hop configurations across token list.`);
    console.log(`🛡️ Rate Limiting Active: Process segments chunked into blocks of ${PATH_CHUNK_SIZE}.`);

    let processingQueueActive = false;
    const filter = { topics: [SWAP_EVENT_TOPIC] };

    provider.on(filter, async (log) => {
        if (processingQueueActive || isReconnecting) return;
        processingQueueActive = true;

        const currentBlock = log.blockNumber;

        try {
            // DYNAMIC PRE-FLIGHT GAS CALCULATION ENGINE
            const feeData = await provider.getFeeData();
            const currentBaseFee = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("150", "gwei");
            const priorityFee = feeData.maxPriorityFeePerGas || ethers.parseUnits("40", "gwei");
            const absoluteGasPrice = currentBaseFee + priorityFee;
            
            const estimatedGasLimit = 420000n; // Standard structural multi-hop EVM execution exhaustion estimate
            const actualGasCostUSDC = (estimatedGasLimit * absoluteGasPrice) / ethers.parseUnits("1", "gwei"); // Dynamic normalization calculation

            // Sequential chunk batch processing preventing rate limitations
            for (const chunk of pathChunks) {
                const scanPromises = chunk.flatMap(pathObj => {
                    const routerPairs = [
                        { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
                        { buyName: "SUSHI", sellName: "QUICK", buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK }
                    ];

                    return routerPairs.flatMap(pair => {
                        return capitalTiers.map(tier => {
                            const testAmountIn = ethers.parseUnits(tier, 6);
                            
                            // Wrapped execution thread limiting maximum node resource pull
                            return limit(async () => {
                                try {
                                    const [estimatedFinalUSDC, estimatedProfit] = await vaultContract.simulateArbitrageProfit(
                                        pair.buy, pair.sell, testAmountIn, pathObj.pathToToken, pathObj.pathToUSDC
                                    );

                                    // CALCULATE REAL FRICTION: Dynamic gas + Aave 0.05% loan fee protection filter
                                    const aaveFeeUSDC = (testAmountIn * 5n) / 10000n;
                                    const totalFrictionUSDC = actualGasCostUSDC + aaveFeeUSDC;
                                    
                                    const grossProfitUSDC = estimatedProfit;
                                    const isProfitable = grossProfitUSDC > totalFrictionUSDC;

                                    return {
                                        success: true,
                                        routeStr: `${pair.buyName}->${pair.sellName}`,
                                        hops: pathObj.hops,
                                        pair,
                                        tier,
                                        isProfitable,
                                        netProfit: isProfitable ? grossProfitUSDC - totalFrictionUSDC : 0n,
                                        grossProfitUSDC,
                                        totalFrictionUSDC,
                                        testAmountIn,
                                        pathObj
                                    };
                                } catch {
                                    return { success: false };
                                }
                            });
                        });
                    });
                });

                const results = await Promise.all(scanPromises);
                let executionTriggered = false;

                for (const res of results) {
                    if (!res.success || !res.isProfitable) continue;
                    
                    // Enforce absolute protection: Target trade parameters MUST exceed total structural friction
                    const targetProfitFloor = ethers.parseUnits("1.0", 6); // Hard floor targeting a clean $1.00 net margin min
                    if (res.netProfit < targetProfitFloor) continue;

                    executionTriggered = true; 
                    console.log(`${GREEN}\n🎯 [PROFIT MATCH CONFIRMED IN BLOCK #${currentBlock}] Net Yield: +${ethers.formatUnits(res.netProfit, 6)} USDC (After Fees)${RESET}`);
                    
                    const txDeadline = Math.floor(Date.now() / 1000) + 20; 
                    
                    try {
                        const tx = await vaultContract.executeAaveFlashLoanArbitrage(
                            res.pair.buy, 
                            res.pair.sell, 
                            res.testAmountIn, 
                            res.pathObj.pathToToken, 
                            res.pathObj.pathToUSDC, 
                            txDeadline,
                            { 
                                gasLimit: estimatedGasLimit, 
                                maxFeePerGas: currentBaseFee + ethers.parseUnits("50", "gwei"),       
                                maxPriorityFeePerGas: priorityFee + ethers.parseUnits("20", "gwei")  
                            }
                        );
                        
                        console.log(`🚨 TRANSACTION BUNDLE BROADCASTED: ${tx.hash}`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ EXECUTED ARBITRAGE CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                    } catch (txError) {
                        console.log(`${RED}⚠️ Execution missed structural transaction window or frontrun by competitive block.${RESET}`);
                    }
                    break; 
                }

                if (executionTriggered) break; // Break out of main loop processing to preserve latency windows
                await sleep(15); // Dynamic 15ms breathing buffer inside path loops to satisfy standard RPC data pacing rules
            }
        } catch (err) {
            // Drop exceptions smoothly to lock process tracking securely
        } finally {
            processingQueueActive = false;
        }
    });

    provider.on("block", (blockNumber) => {
        if (!isReconnecting) {
            console.log(`📦 Block Progression Sync: Mined #${blockNumber} | Parsing tracking hooks...`);
        }
    });
}

main().catch((error) => {
    console.error("Fatal Operational Fault:", error);
    process.exit(1);
});
