import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ==========================================
// 1. HIGH-AVAILABILITY WSS ENDPOINTS TIER
// ==========================================
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

// ==========================================
// 2. FULL EXTENDED TARGET TOKEN MATRIX
// ==========================================
const TOKENS = {
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() view returns (uint256)"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const SWAP_EVENT_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130140159d82c";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================================
// 3. EXHAUSTIVE MULTI-HOP PATH COMBINATORICS
// ==========================================
function buildMultiHopCrossExchangePaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];

    // ---- 3-HOP TRIANGULAR PATHS (USDC -> A -> B -> USDC) ----
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

    // ---- 4-HOP QUADRANGULAR PATHS (USDC -> A -> B -> C -> USDC) ----
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
let usdcContract;
let isReconnecting = false;

const contractMinimumProfitUSDC = 10n; 

async function initWebSocketConnection(targetUrl, onDisconnect) {
    provider = new ethers.WebSocketProvider(targetUrl);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    provider.getNetwork().catch(() => {
        onDisconnect();
    });
}

async function main() {
    if (isReconnecting) return;
    
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    console.log("🚀 REACTIVE EVENT-DRIVEN MULTI-HOP ENGINE ONLINE");
    console.log(`📡 Connecting to high-speed stream gateway: ${targetUrl}`);
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing in environment variables.");
        process.exit(1);
    }

    const handleReconnect = async () => {
        if (isReconnecting) return;
        isReconnecting = true;
        
        console.log(`⚠️ Connection faulted. Cycling to next endpoint position...`);
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
    
    // Upgraded high-scale tiers matching structural 200k framework limits
    const capitalTiers = ["50000", "100000", "150000", "200000"];
    
    console.log(`📊 Matrix initialized with ${multiHopPaths.length * 4} multi-hop permutations.`);
    console.log(`🎯 Active Execution Floor target set to: 0.00001 USDC\n`);

    provider.on("block", (blockNumber) => {
        if (!isReconnecting) {
            console.log(`\n📦 [BLOCK PROGRESSION] Mined: #${blockNumber} | Pipeline active, scanning stream hooks...`);
        }
    });

    let processingQueueActive = false;
    const filter = { topics: [SWAP_EVENT_TOPIC] };

    provider.on(filter, async (log) => {
        if (processingQueueActive || isReconnecting) return;
        processingQueueActive = true;

        const currentBlock = log.blockNumber;

        try {
            const executionMatrix = [];
            const routerPairs = [
                { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
                { buyName: "SUSHI", sellName: "QUICK", buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK }
            ];

            // Map full synchronous permutation payload matrix
            for (const pathObj of multiHopPaths) {
                for (const pair of routerPairs) {
                    for (const tier of capitalTiers) {
                        executionMatrix.push({
                            pair,
                            tier,
                            testAmountIn: ethers.parseUnits(tier, 6),
                            pathObj
                        });
                    }
                }
            }

            // Launch flat parallel queries straight into pipeline stream
            const allScanPromises = executionMatrix.map(item => 
                vaultContract.simulateArbitrageProfit(
                    item.pair.buy,
                    item.pair.sell,
                    item.testAmountIn,
                    item.pathObj.pathToToken,
                    item.pathObj.pathToUSDC
                )
                .then(([estimatedFinalUSDC, estimatedProfit]) => {
                    const isProfitable = estimatedProfit > 0n;
                    const lossDelta = !isProfitable ? (item.testAmountIn > estimatedFinalUSDC ? item.testAmountIn - estimatedFinalUSDC : 0n) : 0n;
                    
                    return {
                        ...item,
                        success: true,
                        isProfitable,
                        estimatedProfit,
                        displayDelta: isProfitable 
                            ? `+${ethers.formatUnits(estimatedProfit, 6)}` 
                            : `-${ethers.formatUnits(lossDelta, 6)}`
                    };
                })
                .catch(() => ({ success: false }))
            );

            const results = await Promise.all(allScanPromises);

            for (const res of results) {
                if (!res.success) continue;
                if (res.displayDelta === "-0.000000" || res.displayDelta === "+0.000000") continue;

                const passesThreshold = res.isProfitable && res.estimatedProfit >= contractMinimumProfitUSDC;
                
                if (!passesThreshold) {
                    // Match visual logging style format exactly for scanned non-profitable indexes
                    const tierPadding = `$${res.tier}`.padEnd(7);
                    const routePadding = `${res.pair.buyName}->${res.pair.sellName}`.padEnd(13);
                    console.log(`📡 [BLOCK #${currentBlock}] Size: ${tierPadding} USDC| Hops: ${res.pathObj.hops} | Route: ${routePadding} | Delta: ${res.displayDelta} USDC`);
                }

                if (passesThreshold) { 
                    console.log(`\n🎯 [PROFITABLE HOOK TRIGGER FOUND IN BLOCK #${currentBlock}]`);
                    console.log(`⚡ Routing $${res.tier} USDC through ${res.pair.buyName} ➡️ ${res.pair.sellName} | Expected Delta: ${res.displayDelta} USDC`);
                    
                    const txDeadline = Math.floor(Date.now() / 1000) + 15; 
                    
                    try {
                        const feeData = await provider.getFeeData();
                        const baseFee = feeData.maxFeePerGas ? feeData.maxFeePerGas : ethers.parseUnits("350", "gwei");

                        const tx = await vaultContract.executeAaveFlashLoanArbitrage(
                            res.pair.buy, 
                            res.pair.sell, 
                            res.testAmountIn, 
                            res.pathObj.pathToToken, 
                            res.pathObj.pathToUSDC, 
                            txDeadline,
                            { 
                                gasLimit: 1200000, 
                                maxFeePerGas: (baseFee * 15n) / 10n, 
                                maxPriorityFeePerGas: ethers.parseUnits("80", "gwei")  
                            }
                        );
                        
                        console.log(`🚀 FLASH LOAN DISPATCHED TO MEMPOOL: ${tx.hash}`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ EXECUTED SUCCESSFULLY IN BLOCK: #${receipt.blockNumber}`);
                    } catch (txError) {
                        // Suppress log fall-through breaks to keep execution queues spinning
                    }
                    break; 
                }
            }
        } catch (err) {
            // Drop exceptions smoothly
        } finally {
            processingQueueActive = false;
        }
    });
}

main().catch((error) => {
    console.error("Fatal Operational Fault:", error);
    process.exit(1);
});
