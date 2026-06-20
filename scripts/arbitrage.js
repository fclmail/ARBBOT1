
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ==========================================================
// 1. HIGH-PERFORMANCE ENDPOINTS TIER
// ==========================================================
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

const TOKENS = {
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
    // ... Append additional token addresses directly here
};

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() view returns (uint256)"
];

const SWAP_EVENT_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130140159d82c";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Native zero-dependency concurrency worker pool
function createConcurrencyLimit(maxConcurrent) {
    return async function (tasks) {
        const results = [];
        const executing = new Set();
        
        for (const task of tasks) {
            const p = Promise.resolve().then(() => task());
            results.push(p);
            executing.add(p);
            
            const clean = () => executing.delete(p);
            p.then(clean, clean);
            
            if (executing.size >= maxConcurrent) {
                await Promise.race(executing);
            }
        }
        return Promise.all(results);
    };
}

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

// Optimization configuration parameters
const MAX_CONCURRENT_REQUESTS = 20; 
const PATH_CHUNK_SIZE = 50; 
const throttle = createConcurrencyLimit(MAX_CONCURRENT_REQUESTS);

// CRITERIA TRIGGER: 10n satisfies exactly 0.00001 USDC target limit (6 decimals)
const STRICT_MINIMUM_PROFIT = 10n; 

async function initWebSocketConnection(targetUrl, onDisconnect) {
    provider = new ethers.WebSocketProvider(targetUrl);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);

    provider.getNetwork().catch(() => { onDisconnect(); });
}

async function main() {
    if (isReconnecting) return;
    
    console.log("🚀 UNRESTRICTED RAW PROFIT ENGINE ONLINE");
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    console.log(`📡 Stream link active: ${targetUrl}`);
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing in environment variables.");
        process.exit(1);
    }

    const handleReconnect = async () => {
        if (isReconnecting) return;
        isReconnecting = true;
        
        console.log(`⚠️ Network node latency fallback triggered. Shifting connection...`);
        currentEndpointIndex = (currentEndpointIndex + 1) % WSS_ENDPOINTS.length;

        if (provider) {
            try { provider.removeAllListeners(); } catch {}
            try { await provider.destroy(); } catch {}
        }
        
        await sleep(2000); 
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
    const capitalTiers = ["100", "500", "1500", "5000"]; 
    const pathChunks = chunkArray(multiHopPaths, PATH_CHUNK_SIZE);
    
    console.log(`📊 Matrix built: Scanning ${multiHopPaths.length} configurations block-by-block.`);
    console.log(`🎯 Trigger Threshold Floor: > 0.00001 USDC (Raw Math Only)`);

    let processingQueueActive = false;
    const filter = { topics: [SWAP_EVENT_TOPIC] };

    provider.on(filter, async (log) => {
        if (processingQueueActive || isReconnecting) return;
        processingQueueActive = true;

        const currentBlock = log.blockNumber;

        try {
            for (const chunk of pathChunks) {
                const scanTasks = chunk.flatMap(pathObj => {
                    const routerPairs = [
                        { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
                        { buyName: "SUSHI", sellName: "QUICK", buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK }
                    ];

                    return routerPairs.flatMap(pair => {
                        return capitalTiers.map(tier => {
                            const testAmountIn = ethers.parseUnits(tier, 6);
                            
                            return async () => {
                                try {
                                    const [, estimatedProfit] = await vaultContract.simulateArbitrageProfit(
                                        pair.buy, pair.sell, testAmountIn, pathObj.pathToToken, pathObj.pathToUSDC
                                    );

                                    // Pure raw verification rule
                                    const isProfitable = estimatedProfit >= STRICT_MINIMUM_PROFIT;

                                    return {
                                        success: true,
                                        routeStr: `${pair.buyName}->${pair.sellName}`,
                                        pair,
                                        isProfitable,
                                        estimatedProfit,
                                        testAmountIn,
                                        pathObj
                                    };
                                } catch {
                                    return { success: false };
                                }
                            };
                        });
                    });
                });

                const results = await throttle(scanTasks);
                let executionTriggered = false;

                for (const res of results) {
                    if (!res.success || !res.isProfitable) continue;

                    executionTriggered = true; 
                    console.log(`${GREEN}\n🎯 [RAW PROFIT TRIGGERED IN BLOCK #${currentBlock}] Profit Found: +${ethers.formatUnits(res.estimatedProfit, 6)} USDC${RESET}`);
                    
                    const txDeadline = Math.floor(Date.now() / 1000) + 30; 
                    
                    try {
                        const tx = await vaultContract.executeAaveFlashLoanArbitrage(
                            res.pair.buy, 
                            res.pair.sell, 
                            res.testAmountIn, 
                            res.pathObj.pathToToken, 
                            res.pathObj.pathToUSDC, 
                            txDeadline,
                            { 
                                gasLimit: 550000, 
                                maxFeePerGas: ethers.parseUnits("280", "gwei"),       
                                maxPriorityFeePerGas: ethers.parseUnits("50", "gwei")  
                            }
                        );
                        
                        console.log(`🚨 BROADCASTING TO MEMPOOL: ${tx.hash}`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ ATOMIC EXECUTION TRANSACTION COMPLETE IN BLOCK: #${receipt.blockNumber}`);
                    } catch (txError) {
                        console.log(`${RED}⚠️ Pipeline transmission failed or reverted during EVM flash checkout.${RESET}`);
                    }
                    break; 
                }

                if (executionTriggered) break; 
            }
        } catch (err) {
            // Absorb logging noise cleanly
        } finally {
            processingQueueActive = false;
        }
    });

    provider.on("block", (blockNumber) => {
        if (!isReconnecting) {
            console.log(`📦 Progression Track: Mined #${blockNumber} | Stream scanning...`);
        }
    });
}

main().catch((error) => {
    console.error("Fatal Pipeline Fault:", error);
    process.exit(1);
});
