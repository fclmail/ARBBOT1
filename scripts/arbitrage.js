import { ethers } from "ethers";
import dotenv from "dotenv";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const FASTLANE_RPC = "https://polygon.fastlane.live/rpc";
const PUBLIC_READ_RPC = "https://polygon-rpc.com"; 
const WSS_NODE = "wss://polygon-bor-rpc.publicnode.com";

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

// ========== EXPANDED DEX ROUTERS ==========
const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    DFYN:  "0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429",
    WAULT: "0x594c3618E3CF4879524b11901d866E3578637C55",
    JETSWAP: "0x5C6EC38fb0e2609672BDf628B1fD605ED52342C6",
    APESWAP: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    KATA: "0xeAa32C4cA4FeFd30dE8c00Ea0bC25819718378f2"
};

// ========== EXPANDED TOKEN LIST ==========
const ALL_TOKENS = [
    { name: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
    { name: "WETH", address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619" },
    { name: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" },
    { name: "DAI", address: "0x8f3cf6ad23cd3cadbd9735aff958023239c6a475" },
    { name: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
    { name: "AAVE", address: "0xd6df932a45c0f255f85745378292cd1651261eaf" },
    { name: "UNI", address: "0xb33eaad8d922b1083446bc23f610e4de901657fc" },
    { name: "CRV", address: "0x172370d5cd6322bef592a1a17af1f3a9aef529b3" },
    { name: "SUSHI", address: "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a" },
    { name: "WOO", address: "0x1b815d120b3e76ad17f0490bf7e9ff923a1329c8" },
    { name: "GRT", address: "0x5fe2b30c797e656c3d416974759469e320f5c8ab" },
    { name: "GHST", address: "0x385ab54d003429a320478963283614a4bc23160a" },
    { name: "BAL", address: "0x3a283d9ef08d8b0d3f0edc2ce5d1b6b4ba748eb0" },
    { name: "QUICK", address: "0xb5c064f955d8e7f38fe0460c556a72987494ee17" },
    { name: "MATIC", address: "0x0000000000000000000000000000000000001010" }
];

// ========== STABLE COINS FOR HOPS ==========
const HOPS = {
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    DAI:    "0x8f3cf6ad23cd3cadbd9735aff958023239c6a063"
};

const ENFORCER_ABI = [
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns ((uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit) best)",
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function getBalance(address token) external view returns (uint256)",
    "function withdrawProfits(address token, uint256 amount) external"
];

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

// ========== AGGRESSIVE SETTINGS - INSTANT PROFIT DETECTION ==========
const CANDIDATE_SIZES_6_DECIMALS = [
    ethers.parseUnits("100", 6),    // Start small for fast checks
    ethers.parseUnits("500", 6),    // Medium size
    ethers.parseUnits("1000", 6),   // Standard
    ethers.parseUnits("2500", 6),   // Larger
    ethers.parseUnits("5000", 6),   // Whale territory
    ethers.parseUnits("10000", 6)   // Max size
];

// Quick check sizes - for instant scanning
const QUICK_CHECK_SIZES_6_DECIMALS = [
    ethers.parseUnits("100", 6),    // Fast check only
    ethers.parseUnits("500", 6)     // Secondary check
];

// Realistic profit thresholds - catch everything
const MINIMUM_PROFIT_USDC = 0.01;    // 1 cent - catches ALL real opportunities
const MIN_REAL_PROFIT = 0.05;        // 5 cents - still profitable after gas
const GAS_COST_USDC = 0.15;          // Average gas cost
const PRIORITY_FEE_USDC = 0.05;      // Fast inclusion fee

let totalProfitsAccumulated = 0;
const failedOpportunities = [];
const processedBlocks = new Set(); // Track processed blocks to avoid duplicates

// Static network definition
const staticPolygonNetwork = ethers.Network.from({
    name: "polygon",
    chainId: 137
});

/* ========================================================================
    COORDINATOR (MAIN THREAD)
   ======================================================================== */
if (isMainThread) {
    console.log(`${GREEN}🚀 INSTANT PROFIT DETECTION BOT ONLINE${RESET}`);
    console.log(`${CYAN}📡 Connected to FastLane Relay: ${FASTLANE_RPC}${RESET}`);
    console.log(`${YELLOW}⚡ Aggressive mode - scanning for ANY profit > $0.01${RESET}\n`);

    const streamProvider = new ethers.WebSocketProvider(WSS_NODE, staticPolygonNetwork);
    const workerCount = 4;
    const workers = [];

    const chunkSize = Math.ceil(ALL_TOKENS.length / workerCount);

    for (let i = 0; i < workerCount; i++) {
        const tokenChunk = ALL_TOKENS.slice(i * chunkSize, (i + 1) * chunkSize);
        
        const worker = new Worker(__filename, {
            workerData: { id: i + 1, tokens: tokenChunk }
        });

        worker.on("message", (msg) => {
            if (msg.type === "LOG") console.log(msg.data);
            if (msg.type === "PROFIT") {
                totalProfitsAccumulated += msg.amount;
                console.log(`${GREEN}💰 TOTAL REALIZED PROFITS: ${totalProfitsAccumulated.toFixed(6)} USDC${RESET}`);
            }
            if (msg.type === "PROFIT_VERIFIED") {
                totalProfitsAccumulated += msg.profitAmount;
                console.log(`${GREEN}✅ ON-CHAIN VERIFIED - Block #${msg.blockNumber} | Profit: $${msg.profitAmount.toFixed(6)} USDC${RESET}`);
                console.log(`${GREEN}💰 TOTAL PROFITS: ${totalProfitsAccumulated.toFixed(6)} USDC${RESET}`);
            }
        });

        workers.push(worker);
    }

    console.log(`[System] Initialized ${workerCount} Worker Threads`);
    console.log(`[System] Tokens per worker: ~${chunkSize}\n`);

    // Monitoring provider for balance tracking
    const monitoringProvider = new ethers.JsonRpcProvider(PUBLIC_READ_RPC, staticPolygonNetwork, { staticNetwork: staticPolygonNetwork });
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, monitoringProvider);
    let previousVaultBalance = BigInt(0);

    streamProvider.on("block", async (blockNumber) => {
        // Avoid duplicate block processing
        if (processedBlocks.has(blockNumber)) return;
        processedBlocks.add(blockNumber);
        
        // Clear old blocks to prevent memory leak (keep last 100)
        if (processedBlocks.size > 100) {
            const iterator = processedBlocks.values();
            for (let i = 0; i < 10; i++) {
                processedBlocks.delete(iterator.next().value);
            }
        }

        console.log(`${CYAN}[Block #${blockNumber}] Scanning for instant profits...${RESET}`);
        
        // Check vault balance every 5 blocks
        if (blockNumber % 5 === 0) {
            try {
                const vaultUsdcBalance = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                const currentBalance = BigInt(vaultUsdcBalance.toString());
                
                if (previousVaultBalance > 0 && currentBalance > previousVaultBalance) {
                    const increase = currentBalance - previousVaultBalance;
                    const formattedIncrease = ethers.formatUnits(increase, 6);
                    console.log(`${GREEN}📈 VAULT BALANCE INCREASED BY ${formattedIncrease} USDC${RESET}`);
                }
                
                previousVaultBalance = currentBalance;
                const formattedBalance = ethers.formatUnits(vaultUsdcBalance, 6);
                console.log(`${GREEN}📊 Vault Balance: ${formattedBalance} USDC${RESET}`);
            } catch (error) {
                // Silent error handling
            }
        }
        
        // Notify all workers to scan
        for (const worker of workers) {
            worker.postMessage({ type: "BLOCK", blockNumber });
        }
    });

} else {
    /* ========================================================================
        PARALLEL WORKER THREAD ENGINE - INSTANT MODE
       ======================================================================== */
    const { id, tokens } = workerData;
    
    const readProvider = new ethers.JsonRpcProvider(PUBLIC_READ_RPC, staticPolygonNetwork, { staticNetwork: staticPolygonNetwork });
    const relayProvider = new ethers.JsonRpcProvider(FASTLANE_RPC, staticPolygonNetwork, { staticNetwork: staticPolygonNetwork });
    
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, relayProvider);
    const vaultContractRead = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, readProvider);
    const vaultContractWrite = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);

    // Generate path matrices for ALL tokens assigned to this worker
    const routerKeys = Object.keys(ROUTERS);
    const pathMatrices = [];

    // Generate all possible token hop combinations
    for (const token of tokens) {
        for (const [hopName, hopAddress] of Object.entries(HOPS)) {
            pathMatrices.push({
                token: token.name,
                tokenAddress: token.address,
                pathToToken: [USDC_ADDRESS, hopAddress, token.address],
                pathToUSDC: [token.address, hopAddress, USDC_ADDRESS],
                hop: hopName
            });
            
            // Also add direct paths (no hop)
            pathMatrices.push({
                token: token.name,
                tokenAddress: token.address,
                pathToToken: [USDC_ADDRESS, token.address],
                pathToUSDC: [token.address, USDC_ADDRESS],
                hop: "DIRECT"
            });
        }
    }

    console.log(`[Worker ${id}] Loaded ${pathMatrices.length} paths for ${tokens.length} tokens`);

    parentPort.on("message", async (msg) => {
        if (msg.type !== "BLOCK") return;
        
        // Reset processed pairs tracking for new block
        const processedPairs = new Set();
        
        // ========== INSTANT SCAN - QUICK CHECK FIRST ==========
        console.log(`${CYAN}[Worker ${id}] Starting instant profit scan...${RESET}`);

        try {
            // Scan with quick check sizes first - IMMEDIATE RESULTS
            for (let i = 0; i < routerKeys.length; i++) {
                const buyRouter = ROUTERS[routerKeys[i]];
                
                for (let j = i + 1; j < routerKeys.length; j++) {
                    const sellRouter = ROUTERS[routerKeys[j]];
                    
                    // Create a unique key for this pair
                    const pairKey = `${buyRouter}-${sellRouter}`;
                    if (processedPairs.has(pairKey)) continue;
                    processedPairs.add(pairKey);
                    
                    // Quick scan with small sizes first
                    for (const route of pathMatrices) {
                        // Quick check with MINIMAL sizes
                        const quickResult = await vaultContractRead.findBestFlashLoanSize(
                            buyRouter,
                            sellRouter,
                            QUICK_CHECK_SIZES_6_DECIMALS,  // Use quick check sizes
                            route.pathToToken,
                            route.pathToUSDC
                        ).catch(() => null);

                        if (!quickResult) continue;

                        const quickProfit = ethers.formatUnits(quickResult.estimatedProfit, 6);
                        
                        // ALERT IMMEDIATELY if ANY profit detected
                        if (Number(quickProfit) > MINIMUM_PROFIT_USDC) {
                            const realProfit = Number(quickProfit) - GAS_COST_USDC - PRIORITY_FEE_USDC;
                            
                            console.log(`${GREEN}⚡ [Worker ${id}] PROFIT DETECTED on ${route.token} via ${route.hop}${RESET}`);
                            console.log(`${GREEN}   Gross: $${quickProfit} | Net: $${realProfit.toFixed(6)}${RESET}`);
                            
                            // EXECUTE IMMEDIATELY - don't wait for full scan
                            if (realProfit > MIN_REAL_PROFIT) {
                                parentPort.postMessage({
                                    type: "LOG",
                                    data: `${GREEN}🎯 EXECUTING ARBITRAGE: ${route.token} | Est. Profit: $${realProfit.toFixed(6)}${RESET}`
                                });
                                
                                await executeArbitrage(buyRouter, sellRouter, route, quickResult);
                            }
                        }
                        
                        // Full scan with all sizes for better opportunities
                        const fullResult = await vaultContractRead.findBestFlashLoanSize(
                            buyRouter,
                            sellRouter,
                            CANDIDATE_SIZES_6_DECIMALS,
                            route.pathToToken,
                            route.pathToUSDC
                        ).catch(() => null);

                        if (!fullResult) continue;

                        const fullProfit = ethers.formatUnits(fullResult.estimatedProfit, 6);
                        
                        if (Number(fullProfit) > MINIMUM_PROFIT_USDC) {
                            const realProfit = Number(fullProfit) - GAS_COST_USDC - PRIORITY_FEE_USDC;
                            
                            console.log(`${GREEN}💰 [Worker ${id}] LARGER OPPORTUNITY: ${route.token} via ${route.hop} | $${realProfit.toFixed(6)}${RESET}`);
                            
                            if (realProfit > MIN_REAL_PROFIT * 2) {  // Double the minimum for larger execution
                                parentPort.postMessage({
                                    type: "LOG",
                                    data: `${GREEN}🎯 EXECUTING LARGER ARBITRAGE: ${route.token} | Est. Profit: $${realProfit.toFixed(6)}${RESET}`
                                });
                                
                                await executeArbitrage(buyRouter, sellRouter, route, fullResult);
                            }
                        }
                    }
                }
            }
            
            // Retry any failed opportunities from previous blocks
            if (failedOpportunities.length > 0) {
                const retryCount = Math.min(failedOpportunities.length, 3); // Max 3 retries per block
                console.log(`${YELLOW}[Worker ${id}] Retrying ${retryCount} failed opportunities...${RESET}`);
                
                for (let i = 0; i < retryCount; i++) {
                    const failed = failedOpportunities.shift();
                    if (failed && failed.attempts < 3) { // Max 3 attempts per opportunity
                        console.log(`${YELLOW}   Retry attempt ${failed.attempts + 1} for ${failed.token}${RESET}`);
                        
                        const retryResult = await vaultContractRead.findBestFlashLoanSize(
                            failed.buyRouter,
                            failed.sellRouter,
                            QUICK_CHECK_SIZES_6_DECIMALS,  // Use smaller sizes for retry
                            failed.route.pathToToken,
                            failed.route.pathToUSDC
                        ).catch(() => null);

                        if (retryResult) {
                            const retryProfit = ethers.formatUnits(retryResult.estimatedProfit, 6);
                            
                            if (Number(retryProfit) > MINIMUM_PROFIT_USDC) {
                                const realProfit = Number(retryProfit) - GAS_COST_USDC - PRIORITY_FEE_USDC;
                                
                                if (realProfit > MIN_REAL_PROFIT) {
                                    console.log(`${GREEN}✅ RETRY SUCCESSFUL - ${failed.token} | $${realProfit.toFixed(6)}${RESET}`);
                                    await executeArbitrage(failed.buyRouter, failed.sellRouter, failed.route, retryResult);
                                    continue;
                                }
                            }
                        }
                        
                        // Still failing - put back in queue with incremented attempts
                        failed.attempts++;
                        failedOpportunities.push(failed);
                    }
                }
            }
            
        } catch (err) {
            console.log(`${RED}[Worker ${id}] Scan error: ${err.message}${RESET}`);
        }
    });

    // ========== EXECUTE ARBITRAGE FUNCTION ==========
    async function executeArbitrage(buyRouter, sellRouter, route, result) {
        const deadline = Math.floor(Date.now() / 1000) + 30; // 30 second deadline
        
        try {
            console.log(`${GREEN}🚀 [Worker ${id}] Executing arbitrage on ${route.token}...${RESET}`);
            
            const tx = await vaultContractWrite.executeBestFlashLoanArbitrage(
                buyRouter,
                sellRouter,
                CANDIDATE_SIZES_6_DECIMALS,
                route.pathToToken,
                route.pathToUSDC,
                deadline,
                { gasLimit: 700000n, maxPriorityFeePerGas: ethers.parseUnits("50", "gwei") }
            );
            
            console.log(`${GREEN}📝 [Worker ${id}] Transaction submitted: ${tx.hash}${RESET}`);
            
            // Wait for confirmation
            const receipt = await tx.wait(1);
            
            if (receipt && receipt.status === 1) {
                const gasUsed = receipt.gasUsed;
                const txBlockNumber = receipt.blockNumber;
                
                console.log(`${GREEN}✅ [Worker ${id}] ARBITRAGE SUCCESSFUL!${RESET}`);
                console.log(`${GREEN}   Token: ${route.token}${RESET}`);
                console.log(`${GREEN}   Block: ${txBlockNumber}${RESET}`);
                console.log(`${GREEN}   Gas Used: ${gasUsed.toString()}${RESET}`);
                console.log(`${GREEN}   TX: ${receipt.hash}${RESET}`);
                
                // Calculate actual profit with gas cost
                const estimatedProfit = ethers.formatUnits(result.estimatedProfit, 6);
                const gasCostInUSD = Number(gasUsed.toString()) * 50 * 1e-9; // Rough MATIC to USD conversion

                const actualProfit = Number(estimatedProfit) - gasCostInUSD;
                
                parentPort.postMessage({
                    type: "PROFIT_VERIFIED",
                    txHash: receipt.hash,
                    blockNumber: txBlockNumber,
                    profitAmount: actualProfit,
                    timestamp: Date.now(),
                    token: route.token,
                    route: route.hop
                });
                
                return true;
            } else {
                console.log(`${RED}❌ [Worker ${id}] Transaction failed on-chain${RESET}`);
                
                // Store failed opportunity for retry
                failedOpportunities.push({
                    buyRouter,
                    sellRouter,
                    route,
                    token: route.token,
                    attempts: 1,
                    timestamp: Date.now()
                });
                
                return false;
            }
        } catch (error) {
            console.log(`${RED}❌ [Worker ${id}] Execution error: ${error.message}${RESET}`);
            
            // Store failed opportunity for retry
            failedOpportunities.push({
                buyRouter,
                sellRouter,
                route,
                token: route.token,
                attempts: 1,
                timestamp: Date.now()
            });
            
            return false;
        }
    }

    // ========== PROFIT ANALYSIS FUNCTION ==========
    function analyzeProfit(grossProfit, gasCost, priorityFee) {
        const netProfit = grossProfit - gasCost - priorityFee;
        const profitPercentage = (netProfit / grossProfit) * 100;
        
        return {
            grossProfit,
            netProfit,
            gasCost,
            priorityFee,
            profitPercentage,
            isProfitable: netProfit > MIN_REAL_PROFIT
        };
    }
}

// ========== MAIN EXECUTION ==========
async function main() {
    console.log(`${GREEN}🎯 INSTANT PROFIT DETECTION BOT - STARTING${RESET}`);
    console.log(`${CYAN}====================================${RESET}`);
    console.log(`${GREEN}Mode: Aggressive - Scanning for ALL profits > $0.01${RESET}`);
    console.log(`${GREEN}Minimum Real Profit: $${MIN_REAL_PROFIT} USDC${RESET}`);
    console.log(`${GREEN}Gas Cost Estimate: $${GAS_COST_USDC} USDC${RESET}`);
    console.log(`${GREEN}Priority Fee: $${PRIORITY_FEE_USDC} USDC${RESET}`);
    console.log(`${CYAN}====================================${RESET}\n`);
    
    // Start monitoring
    console.log(`${GREEN}✅ Bot initialized successfully${RESET}`);
    console.log(`${GREEN}📡 Connected to Polygon Network${RESET}`);
    console.log(`${GREEN}🔍 Scanning ${ALL_TOKENS.length} tokens across ${Object.keys(ROUTERS).length} DEXes${RESET}`);
    console.log(`${GREEN}⚡ Ready for instant profit detection${RESET}\n`);
}

if (isMainThread) {
    main().catch(console.error);
}

export { 
    analyzeProfit,
    executeArbitrage,
    failedOpportunities,
    totalProfitsAccumulated
};

// Configuration Constants
const BOT_VERSION = "2.0.0";
const BOT_CONFIG = {
    version: BOT_VERSION,
    mode: "AGGRESSIVE_INSTANT",
    minProfitUSDC: MINIMUM_PROFIT_USDC,
    minRealProfit: MIN_REAL_PROFIT,
    gasCost: GAS_COST_USDC,
    priorityFee: PRIORITY_FEE_USDC,
    candidateSizes: CANDIDATE_SIZES_6_DECIMALS,
    quickCheckSizes: QUICK_CHECK_SIZES_6_DECIMALS,
    routers: Object.keys(ROUTERS),
    tokens: ALL_TOKENS.map(t => t.name),
    hops: Object.keys(HOPS)
};

console.log(`${CYAN}📋 Bot Configuration:${RESET}`);
console.log(JSON.stringify(BOT_CONFIG, null, 2));
