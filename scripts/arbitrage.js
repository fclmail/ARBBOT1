import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ==========================================
// 1. HIGH-AVAILABILITY WSS ENDPOINTS TIER
// ==========================================
const WSS_ENDPOINTS = [
    "wss://polygon-bor-rpc.publicnode.com", // Reliable unauthenticated public WSS
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

    // ---- 4-HOP QUADRANGULAR PATHS ONLY (Targeting Max-Imbalance Spreads) ----
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
const contractMinimumProfitUSDC = 2000000n; // Set floor threshold to $2.00 target minimum

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
    
    // Narrowed Capital Tiers to Optimize Bandwidth
    const capitalTiers = ["150000", "200000"];

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
                    const tierPadding = `$${res.tier}`.padEnd(7);
                    const routePadding = `${res.pair.buyName}->${res.pair.sellName}`.padEnd(13);
                    console.log(`📡 [BLOCK #${blockNumber}] Size: ${tierPadding} USDC| Hops: ${res.pathObj.hops} | Route: ${routePadding} | Delta: ${res.displayDelta} USDC`);
                }

                if (passesThreshold) { 
                    console.log(`\n🎯 [PROFITABLE HOOK TRIGGER FOUND IN BLOCK #${blockNumber}]`);
                    
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
                        
                        console.log(`🚀 TRANSACTION DISPATCHED VIA FASTLANE: ${tx.hash.substring(0, 6)}...`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ EXECUTED SUCCESSFULLY IN BLOCK: #${receipt.blockNumber}`);
                        
                        const postVaultBalance = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        console.log(`🏁 NET BALANCE ACCUMULATED: +${ethers.formatUnits(res.estimatedProfit, 6)} USDC`);
                    } catch (txError) {
                        // Silent failover protection
                    }
                    break; 
                }
            }
        } catch (err) {
            // Catch error array variations cleanly
        } finally {
            processingQueueActive = false;
        }
    });
}

main().catch((error) => {
    process.exit(1);
});
