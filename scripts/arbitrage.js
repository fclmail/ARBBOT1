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
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    QUICK:  "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

// Full ABI to completely support your contract's read and write workflows
const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() view returns (uint256)"
];
const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BATCH_SIZE = 2; // Reduced batch size slightly since view calls to simulate have minor latency overhead

function buildTriangularPaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];
    for (const a of tokenAddresses) {
        for (const b of tokenAddresses) {
            if (a === b) continue;
            generatedPaths.push({
                pathToToken: [USDC_ADDRESS, a, b],
                pathToUSDC: [b, USDC_ADDRESS]
            });
        }
    }
    return generatedPaths;
}

let provider;
let wallet;
let vaultContract;
let usdcContract;
let isReconnecting = false;
let globalMinProfitFloor = 50000n; // Fallback 0.05 USDC (6 decimals)

function initWebSocketConnection(onDisconnect) {
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    const ws = new WebSocket(targetUrl);
    
    ws.on("error", () => {
        ws.terminate();
    });

    provider = new ethers.WebSocketProvider(() => ws);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    ws.on("close", () => {
        currentEndpointIndex = (currentEndpointIndex + 1) % WSS_ENDPOINTS.length;
        onDisconnect();
    });
}

async function main() {
    if (isReconnecting) return;
    
    console.log("🚀 BOT STARTED - AAVE V3 FLASH LOAN ENGINE RUNNING");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing.");
        process.exit(1);
    }

    let blockProcessingActive = false;

    const handleReconnect = async () => {
        if (isReconnecting) return;
        isReconnecting = true;
        if (provider) {
            try { provider.removeAllListeners("block"); } catch {}
            try { await provider.destroy(); } catch {}
        }
        await sleep(4000); 
        isReconnecting = false;
        main().catch(() => {});
    };

    initWebSocketConnection(handleReconnect);
    
    // Sync to the exact minimum profit specified inside your deployed smart contract instance
    try {
        globalMinProfitFloor = await vaultContract.minimumProfitUSDC();
        console.log(`ℹ️ Synced minimum profit threshold from contract: ${ethers.formatUnits(globalMinProfitFloor, 6)} USDC`);
    } catch (e) {
        console.log(`⚠️ Could not fetch minProfit from contract, utilizing fallback: 0.05 USDC`);
    }

    const triangularPaths = buildTriangularPaths();
    const capitalTiers = ["0.01", "0.10", "1", "10", "100", "1000"];

    provider.on("block", async (freshBlock) => {
        if (blockProcessingActive || isReconnecting) return; 
        blockProcessingActive = true;

        console.log(`\n⚡ LIVE BLOCK DETECTED VIA WSS: #${freshBlock} | Scanning Matrix Pipelines...`);

        try {
            for (let i = 0; i < triangularPaths.length; i += BATCH_SIZE) {
                if (isReconnecting) break;
                const pathChunk = triangularPaths.slice(i, i + BATCH_SIZE);
                const scanPromises = [];

                for (let pathObj of pathChunk) {
                    for (let routerKey of Object.keys(ROUTERS)) {
                        for (let tier of capitalTiers) {
                            const testAmountIn = ethers.parseUnits(tier, 6);
                            const targetRouterAddress = ROUTERS[routerKey];
                            
                            // Let the contract simulate the exact path execution natively
                            scanPromises.push(
                                vaultContract.simulateArbitrageProfit(
                                    targetRouterAddress,
                                    targetRouterAddress,
                                    testAmountIn,
                                    pathObj.pathToToken,
                                    pathObj.pathToUSDC
                                )
                                .then(([estimatedFinalUSDC, estimatedProfit]) => {
                                    const isProfitable = estimatedProfit > 0n;
                                    const lossDelta = !isProfitable ? (testAmountIn > estimatedFinalUSDC ? testAmountIn - estimatedFinalUSDC : 0n) : 0n;
                                    
                                    return {
                                        success: true,
                                        routerKey,
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

                const results = await Promise.all(scanPromises);
                let executionTriggered = false;

                for (const res of results) {
                    if (!res.success) continue;
                    if (res.displayDelta === "-0.000000" || res.displayDelta === "+0.000000") continue;

                    const logColor = res.isProfitable ? GREEN : RESET;
                    console.log(`${logColor}    📡 [AUDIT] Size: $${res.tier.padEnd(6)} USDC | Router: ${res.routerKey.padEnd(5)} | Delta: ${res.displayDelta} USDC${RESET}`);

                    // Trigger execution only if profit exceeds the contract's strict requirement threshold
                    if (res.isProfitable && res.estimatedProfit >= globalMinProfitFloor && !executionTriggered) { 
                        executionTriggered = true; 
                        
                        console.log(`${GREEN}\n🎯 [MATCH FOUND] Execution Triggered via Aave Flash Loan: ${res.displayDelta} USDC${RESET}`);
                        
                        const targetRouterAddress = ROUTERS[res.routerKey];
                        const txDeadline = Math.floor(Date.now() / 1000) + 30; 
                        
                        try {
                            const tx = await vaultContract.executeAaveFlashLoanArbitrage(
                                targetRouterAddress, 
                                targetRouterAddress, 
                                res.testAmountIn, 
                                res.pathObj.pathToToken, 
                                res.pathObj.pathToUSDC, 
                                txDeadline,
                                { 
                                    gasLimit: 850000, 
                                    maxFeePerGas: ethers.parseUnits("280", "gwei"),       
                                    maxPriorityFeePerGas: ethers.parseUnits("45", "gwei")  
                                }
                            );
                            
                            console.log(`🚨 FLASH LOAN TX DISPATCHED: ${tx.hash}`);
                            
                            const receipt = await tx.wait(1);
                            console.log(`✅ AAVE FLASH LOAN SUCCESSFUL IN BLOCK: #${receipt.blockNumber}`);
                            
                            const updatedVaultBalance = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                            console.log(`💰 ACCUMULATED CONTRACT BALANCE: ${ethers.formatUnits(updatedVaultBalance, 6)} USDC`);
                        } catch (txError) {
                            console.log(`${RED}❌ Transaction dropped/reverted on-chain. Capital remains safe. Moving forward...${RESET}`);
                        }
                        break; 
                    }
                }
                if (executionTriggered) break;
            }
        } catch (globalError) {
            // Drops scanning pipeline errors cleanly
        } finally {
            blockProcessingActive = false; 
        }
    });
}

main().catch((error) => {
    console.error("Fatal Execution Fault:", error);
    process.exit(1);
});
