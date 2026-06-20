import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

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
    USDT:             "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WETH:             "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC:           "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    DAI:              "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC:             "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeDirectCapitalArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];

const SWAP_EVENT_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130140159d82c";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    for (const token of tokenAddresses) {
        if (token.toLowerCase() === USDC_ADDRESS.toLowerCase()) continue;
        generatedPaths.push({
            hops: 2,
            pathToToken: [USDC_ADDRESS, token],
            pathToUSDC: [token, USDC_ADDRESS]
        });
    }
    return generatedPaths;
}

let provider;
let wallet;
let vaultContract;
let isReconnecting = false;

const MAX_CONCURRENT_REQUESTS = 25; 
const PATH_CHUNK_SIZE = 60; 
const throttle = createConcurrencyLimit(maxConcurrentRequests);

// Raw check baseline remains micro-scale to verify calculation streams
const STRICT_MINIMUM_PROFIT = 10n; 
const ESTIMATED_GAS_LIMIT = 400000n;

async function initWebSocketConnection(targetUrl, onDisconnect) {
    provider = new ethers.WebSocketProvider(targetUrl);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    provider.getNetwork().catch(() => { onDisconnect(); });
}

async function main() {
    if (isReconnecting) return;
    
    console.log("🚀 UNRESTRICTED REAL-TIME NET BALANCE MONITORING ONLINE");
    const targetUrl = WSS_ENDPOINTS[currentEndpointIndex];
    
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
    const capitalTiers = ["0.10", "1.00", "5.00", "10.00"]; 
    const pathChunks = chunkArray(multiHopPaths, PATH_CHUNK_SIZE);

    let processingQueueActive = false;
    const filter = { topics: [SWAP_EVENT_TOPIC] };

    provider.on(filter, async (log) => {
        if (processingQueueActive || isReconnecting) return;
        processingQueueActive = true;

        try {
            // Fetch live gas environment context dynamically
            const feeData = await provider.getFeeData();
            const currentGasPrice = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("150", "gwei");
            
            // Approximate gas fee baseline calculation in USDC terms ($0.05 - $0.15 typically)
            const estimatedGasCostUSDC = 0.08; 

            for (const chunk of pathChunks) {
                const scanTasks = chunk.flatMap((pathObj) => {
                    const routerPairs = [
                        { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
                        { buyName: "SUSHI", sellName: "QUICK", buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK }
                    ];

                    return routerPairs.flatMap((pair) => {
                        return capitalTiers.map((tier) => {
                            const testAmountIn = ethers.parseUnits(tier, 6);
                            
                            return async () => {
                                try {
                                    const [, estimatedProfit] = await vaultContract.simulateArbitrageProfit(
                                        pair.buy, pair.sell, testAmountIn, pathObj.pathToToken, pathObj.pathToUSDC
                                    );
                                    return {
                                        success: true,
                                        routeStr: `${pair.buyName}->${pair.sellName}`,
                                        pair,
                                        estimatedProfit,
                                        testAmountIn,
                                        tier,
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
                    if (!res.success) continue;

                    const rawProfit = res.estimatedProfit;

                    if (rawProfit >= STRICT_MINIMUM_PROFIT) {
                        const grossProfit = Number(ethers.formatUnits(rawProfit, 6));
                        const netProfit = grossProfit - estimatedGasCostUSDC;

                        const sign = netProfit >= 0 ? "+" : "";
                        const color = netProfit >= 0 ? GREEN : RED;

                        // Unified Stream Tracking logging both net wins and fee-drag losses
                        console.log(`${color}📡 [SPREAD FOUND] Route: ${res.routeStr} | Input: $${res.tier} | Gross: +${grossProfit.toFixed(6)} | Net: ${sign}${netProfit.toFixed(6)} USDC${RESET}`);

                        // Execution logic strictly guarded by mathematical viability
                        if (netProfit > 0) {
                            executionTriggered = true;
                            console.log(`${GREEN}🚨 POSITIVE NET EXPECTATION DETECTED: Dispatching Execution Block...${RESET}`);
                            
                            const txDeadline = Math.floor(Date.now() / 1000) + 30;
                            try {
                                const tx = await vaultContract.executeDirectCapitalArbitrage(
                                    res.pair.buy, res.pair.sell, res.testAmountIn, res.pathObj.pathToToken, res.pathObj.pathToUSDC, txDeadline,
                                    { 
                                        gasLimit: ESTIMATED_GAS_LIMIT,
                                        maxFeePerGas: currentGasPrice,       
                                        maxPriorityFeePerGas: ethers.parseUnits("60", "gwei")  
                                    }
                                );
                                console.log(`${GREEN}🚨 Mempool Broadcast: ${tx.hash}${RESET}`);
                                await tx.wait(1);
                            } catch (txError) {
                                console.log(`${RED}⚠️ Reverted or outbid in flight.${RESET}`);
                            }
                            break;
                        }
                    }
                }
                if (executionTriggered) break;
            }
        } catch (err) {
            // Context bypass safe
        } finally {
            processingQueueActive = false;
        }
    });

    provider.on("block", (blockNumber) => {
        if (!isReconnecting) console.log(`📦 Block #${blockNumber} Processing Stream...`);
    });
}

main().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
});
