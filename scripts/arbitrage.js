
import { ethers } from "ethers";
import dotenv from "dotenv";
import WebSocket from "ws";

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

// Uniswap V2 / QuickSwap Core Standard Swap Event Signature Topic
const SWAP_EVENT_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130140159d82c";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
let usdcContract;
let isReconnecting = false;

// Configured precisely to your contract requirement: 0.00001 USDC (6 decimals = 10 units)
const contractMinimumProfitUSDC = 10n; 

function initWebSocketConnection(onDisconnect) {
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    console.log(`📡 Connecting to high-speed stream gateway: ${targetUrl}`);
    const ws = new WebSocket(targetUrl);
    
    ws.on("error", () => {
        ws.terminate();
    });

    provider = new ethers.WebSocketProvider(() => ws);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    ws.on("close", () => {
        console.log("⚠️ Connection dropped. Swapping to alternate high-availability node...");
        currentEndpointIndex = (currentEndpointIndex + 1) % WSS_ENDPOINTS.length;
        onDisconnect();
    });
}

async function main() {
    if (isReconnecting) return;
    
    console.log("🚀 REACTIVE EVENT-DRIVEN MULTI-HOP ENGINE ONLINE");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing in variables environment.");
        process.exit(1);
    }

    const handleReconnect = async () => {
        if (isReconnecting) return;
        isReconnecting = true;
        if (provider) {
            try { provider.removeAllListeners(); } catch {}
            try { await provider.destroy(); } catch {}
        }
        await sleep(2000); 
        isReconnecting = false;
        main().catch(() => {});
    };

    initWebSocketConnection(handleReconnect);

    const multiHopPaths = buildMultiHopCrossExchangePaths();
    const capitalTiers = ["10", "50", "200", "500", "1200", "2500", "5000"];
    
    console.log(`📊 Matrix initialized with ${multiHopPaths.length} multi-hop configurations.`);
    console.log(`🎯 Active Execution Floor target set to: ${ethers.formatUnits(contractMinimumProfitUSDC, 6)} USDC (0.00001)`);
    console.log(`⚡ Subscribed to pool Swap events. Listening for on-chain price dislocation hooks...`);

    let processingQueueActive = false;

    // Reactive Filter: Listen directly to raw logs matching standard Swap signatures 
    const filter = {
        topics: [SWAP_EVENT_TOPIC]
    };

    provider.on(filter, async (log) => {
        if (processingQueueActive || isReconnecting) return;
        processingQueueActive = true;

        try {
            const allScanPromises = [];

            for (const pathObj of multiHopPaths) {
                const routerPairs = [
                    { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
                    { buyName: "SUSHI", sellName: "QUICK", buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK }
                ];

                for (const pair of routerPairs) {
                    for (const tier of capitalTiers) {
                        const testAmountIn = ethers.parseUnits(tier, 6);
                        
                        allScanPromises.push(
                            vaultContract.simulateArbitrageProfit(
                                pair.buy,
                                pair.sell,
                                testAmountIn,
                                pathObj.pathToToken,
                                pathObj.pathToUSDC
                            )
                            .then(([estimatedFinalUSDC, estimatedProfit]) => {
                                const isProfitable = estimatedProfit > 0n;
                                const lossDelta = !isProfitable ? (testAmountIn > estimatedFinalUSDC ? testAmountIn - estimatedFinalUSDC : 0n) : 0n;
                                
                                return {
                                    success: true,
                                    routeStr: `${pair.buyName}->${pair.sellName}`,
                                    hops: pathObj.hops,
                                    pair,
                                    tier,
                                    isProfitable,
                                    estimatedProfit,
                                    displayDelta: isProfitable 
                                        ? `+${ethers.formatUnits(estimatedProfit, 6)}` 
                                        : `-${ethers.formatUnits(lossDelta, 6)}`,
                                    testAmountIn,
                                    pathObj
                                };
                            })
                            .catch(() => ({ success: false }))
                        );
                    }
                }
            }

            const results = await Promise.all(allScanPromises);
            let executionTriggered = false;

            for (const res of results) {
                if (!res.success) continue;
                if (res.displayDelta === "-0.000000" || res.displayDelta === "+0.000000") continue;

                // Color-code winning metrics in green
                const logColor = res.isProfitable && res.estimatedProfit >= contractMinimumProfitUSDC ? GREEN : RESET;
                console.log(`${logColor}    📡 [WSS SWAP EVENT DETECTED] Size: $${res.tier.padEnd(6)} USDC | Hops: ${res.hops} | Route: ${res.routeStr.padEnd(12)} | Delta: ${res.displayDelta} USDC${RESET}`);

                // Direct instant execution route triggers when profit threshold condition is met
                if (res.isProfitable && res.estimatedProfit >= contractMinimumProfitUSDC && !executionTriggered) { 
                    executionTriggered = true; 
                    
                    console.log(`${GREEN}\n🎯 [PROFITABLE TRIGGER FOUND] Instantly executing flash loan: ${res.displayDelta} USDC${RESET}`);
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
                                gasLimit: 980000, 
                                maxFeePerGas: ethers.parseUnits("320", "gwei"),       
                                maxPriorityFeePerGas: ethers.parseUnits("60", "gwei")  
                            }
                        );
                        
                        console.log(`🚨 FLASH LOAN TX SENT TO MEMPOOL: ${tx.hash}`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ EXECUTED TRANSACTION CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                    } catch (txError) {
                        console.log(`${RED}❌ Transaction reverted on-chain. Capital remains safe.${RESET}`);
                    }
                    break;
                }
            }
        } catch (err) {
            // Drop execution anomalies cleanly
        } finally {
            processingQueueActive = false;
        }
    });
}

main().catch((error) => {
    console.error("Fatal Operational Fault:", error);
    process.exit(1);
});
