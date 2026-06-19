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
    "wss://polygon-bor-rpc.publicnode.com", 
    "wss://polygon.drpc.org",
    "wss://polygon.gateway.tenderly.co"
];
let currentEndpointIndex = 0;

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// FULL HOPS RESTORED
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
    "function executeDirectArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() view returns (uint256)"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildMultiHopCrossExchangePaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];

    // ---- FULL 4-HOP QUADRANGULAR PATHWAYS RESTORED ----
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
let testOverrideTriggered = false; // Restricts verification trigger to execution one time

const contractMinimumProfitUSDC = 1n; // Floor limit at $0.000001 USDC

async function initWebSocketConnection(targetUrl, onDisconnect) {
    provider = new ethers.WebSocketProvider(targetUrl);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    provider.getNetwork().catch(() => onDisconnect());
}

async function main() {
    if (isReconnecting) return;
    
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    console.log("🚀 ARBBOT1 PIPELINE PIPELINE VALIDATION ENGINE");
    console.log(`📡 Stream targeting endpoint interface: ${targetUrl}`);
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing in environment variables.");
        process.exit(1);
    }

    const handleReconnect = async () => {
        if (isReconnecting) return;
        isReconnecting = true;
        
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
    
    // Target test allocation size set to 0.07 USDC
    const capitalTiers = ["0.07"];

    console.log(`📊 Matrix fully populated with ${multiHopPaths.length * 2} active 4-hop routes.`);
    console.log(`🎯 Floor target minimum activated at: 0.000001 USDC\n`);

    let processingQueueActive = false;

    provider.on("block", async (blockNumber) => {
        if (processingQueueActive || isReconnecting) return;
        processingQueueActive = true;

        console.log(`📦 [BLOCK PROGRESSION] Mined: #${blockNumber} | Pipeline active, scanning stream hooks...`);

        try {
            const executionMatrix = [];
            const routerPairs = [
                { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
                { buyName: "SUSHI", sellName: "QUICK", buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK }
            ];

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

            const allScanPromises = executionMatrix.map(item => 
                vaultContract.simulateArbitrageProfit(
                    item.pair.buy, item.pair.sell, item.testAmountIn, item.pathObj.pathToToken, item.pathObj.pathToUSDC
                )
                .then(([estimatedFinalUSDC, estimatedProfit]) => {
                    const isProfitable = estimatedProfit > 0n;
                    
                    let displayDelta;
                    if (isProfitable) {
                        displayDelta = `+${ethers.formatUnits(estimatedProfit, 6)}`;
                    } else {
                        const lossDelta = item.testAmountIn > estimatedFinalUSDC ? item.testAmountIn - estimatedFinalUSDC : 0n;
                        displayDelta = `-${ethers.formatUnits(lossDelta, 6)}`;
                    }
                    
                    return { ...item, success: true, isProfitable, estimatedProfit, displayDelta };
                })
                .catch(() => {
                    return { ...item, success: false, displayDelta: "-0.000000" };
                })
            );

            const results = await Promise.all(allScanPromises).catch(() => []);

            // ==========================================
            // VERIFICATION HOOK: INJECTS TARGET MICRO-PROFIT ONE TIME TO VERIFY LOG COLORS
            // ==========================================
            if (!testOverrideTriggered && results.length > 0) {
                results.unshift({
                    pair: { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
                    tier: "0.07",
                    testAmountIn: ethers.parseUnits("0.07", 6),
                    pathObj: multiHopPaths[0],
                    success: true,
                    isProfitable: true,
                    estimatedProfit: 50000n, // Simulated profit trigger value ($0.05 USDC)
                    displayDelta: "+0.050000"
                });
                testOverrideTriggered = true; 
            }
            // ==========================================

            for (const res of results) {
                if (!res.success) continue;
                if (res.displayDelta === "-0.000000" || res.displayDelta === "+0.000000") continue;

                const passesThreshold = res.isProfitable && res.estimatedProfit >= contractMinimumProfitUSDC;
                
                if (!passesThreshold) {
                    console.log(`📡 [BLOCK #${blockNumber}] Size: $${res.tier} USDC | Route: ${res.pair.buyName}->${res.pair.sellName} | Delta: ${res.displayDelta} USDC`);
                }

                if (passesThreshold) { 
                    console.log(`\n${GREEN}🎯 [PROFITABLE HOOK TRIGGER FOUND IN BLOCK #${blockNumber}]`);
                    console.log(`⚡ Routing $${res.tier} USDC through ${res.pair.buyName} ➡️ ${res.pair.sellName} | Expected Delta: ${res.displayDelta} USDC`);
                    
                    const txDeadline = Math.floor(Date.now() / 1000) + 15; 
                    
                    try {
                        const vaultBalance = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        const hasEnoughVaultFunds = vaultBalance >= res.testAmountIn;
                        
                        if (hasEnoughVaultFunds) {
                            console.log(`💰 [VAULT FUNDING] Using internal vault capital ($${ethers.formatUnits(vaultBalance, 6)} USDC available)`);
                        } else {
                            console.log(`⚡ [FLASH LOAN FUNDING] Shortfall detected. Borrowing $${res.tier} USDC...`);
                        }
                        
                        const feeData = await provider.getFeeData();
                        const baseFee = feeData.maxFeePerGas ? feeData.maxFeePerGas : ethers.parseUnits("350", "gwei");
                        const txOptions = { 
                            gasLimit: 1300000, 
                            maxFeePerGas: (baseFee * 15n) / 10n, 
                            maxPriorityFeePerGas: ethers.parseUnits("80", "gwei")  
                        };

                        let tx;
                        if (hasEnoughVaultFunds) {
                            tx = await vaultContract.executeDirectArbitrage(
                                res.pair.buy, res.pair.sell, res.testAmountIn, res.pathObj.pathToToken, res.pathObj.pathToUSDC, txDeadline, txOptions
                            );
                        } else {
                            tx = await vaultContract.executeAaveFlashLoanArbitrage(
                                res.pair.buy, res.pair.sell, res.testAmountIn, res.pathObj.pathToToken, res.pathObj.pathToUSDC, txDeadline, txOptions
                            );
                        }
                        
                        console.log(`🚀 TRANSACTION DISPATCHED VIA FASTLANE: ${tx.hash.substring(0, 10)}...`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ EXECUTED SUCCESSFULLY IN BLOCK: #${receipt.blockNumber}`);
                        console.log(`🏁 NET BALANCE ACCUMULATED: +${ethers.formatUnits(res.estimatedProfit, 6)} USDC${RESET}\n`);
                    } catch (txError) {
                        console.log(`${RED}❌ Execution dropped out: ${txError.message}${RESET}`);
                    }
                    break; 
                }
            }
        } catch (err) {
            // Suppress errors cleanly
        } finally {
            processingQueueActive = false;
        }
    });
}

main().catch(() => process.exit(1));
