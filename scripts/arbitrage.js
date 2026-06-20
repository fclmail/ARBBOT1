
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
    // --- Initial Core Pairs ---
    USDT:             "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WETH:             "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC:           "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    DAI:              "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC:             "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",

    // --- Batch 1 ---
    AVAX:             "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b",
    FET:              "0x7583feddbcefa813dc18259940f76a02710a8905",
    INJ:              "0x4e8dc2149eac3f3def36b1c281ea466338249371",
    RNDR:             "0x61299774020da444af134c82fa83e3810b309991",
    UNI:              "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
    PYUSD0:           "0x99af3eea856556646c98c8b9b2548fe815240750",
    PAXG:             "0x553d3d295e0f695b9228246232edf400ed3560b5",
    SXP:              "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
    POLY:             "0xcb059c5573646047d6d88dddb87b745c18161d3b",
    CHZ:              "0xf1938ce12400f9a761084e7a80d37e732a4da056",
    SHIB:             "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec",
    CRVUSD:           "0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6",
    APE:              "0xB7b31a6BC18e48888545CE79e83E06003bE70930",
    ZRO:              "0x6985884c4392d348587b19cb9eaaf157f13271cd",
    CRV:              "0x172370d5cd63279efa6d502dab29171933a610af",
    LDO:              "0xc3c7d422809852031b44ab29eec9f1eff2a58756",
    APEPE:            "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a",
    STG:              "0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590",
    SAND:             "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",
    TUSD:             "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
    USDQ:             "0xb291996477504506bf5f583102b5b5ea5d1e40e0",
    FRXUSD:           "0x80eede496655fb9047dd39d9f418d5483ed600df",
    SUSHI:            "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a",
    GRT:              "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
    LPT:              "0x3962f4a0a0051dcce0be73a7e09cef5756736712",
    PAX:              "0x6f3b3286fd86d8b47ec737ceb3d0d354cc657b3e",

    // --- Batch 2 ---
    AUSD:             "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    BAT:              "0x3cef98bb43d732e2f285ee605a8158cde967d219",
    TBTC:             "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
    MANA:             "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
    TRB:              "0xe3322702bedaaed36cddab233360b939775ae5f1",
    COMP:             "0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
    "1INCH":          "0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
    THETA:            "0xb46e0ae620efd98516f49bb00263317096c114b2",
    CRO:              "0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
    XYO:              "0xd2507e7b5794179380673870d88b22f94da6abe0",
    MASK:             "0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7",
    EURQ:             "0xd571edb2ef29df10fcd6200fd6d0ed2389983db3",
    APOLUSDT:         "0x6ab707aca953edaefbc4fd23ba73294241490620",
    ENJ:              "0x7ec26842f195c852fa843bb9f6d8b583a274a157",
    ZRX:              "0x5559edb74751a0ede9dea4dc23aee72cca6be3d5",
    GMT:              "0x714db550b574b3e927af3d93e26127d15721d4c2",
    SNX:              "0x50b728d8d964fd00c2d0aad81718b71311fef68a",
    ANKR:             "0x101a023270368c0d50bffb62780f4afd4ea79c35",
    GLM:              "0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
    COW:              "0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
    BAND:             "0xa8b1e0764f85f53dfe21760e8afe5446d82606ac",
    AXL:              "0x6e4e624106cb12e168e6533f8ec7c82263358940",
    UMA:              "0x3066818837c5e6ed6601bd5a91b0762877a6b731",
    YFI:              "0xda537104d6a5edd53c6fbba9a898708e465260b6",
    ELON:             "0xe0339c80ffde91f3e20494df88d4206d86024cdf",
    NEXO:             "0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
    EURAU:            "0x4933A85b5b5466Fbaf179F72D3DE273c287EC2c2",
    ORDER:            "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
    IOTX:             "0xf6372cdb9c1d3674e83842e3800f2a62ac9f3c66",
    AMP:              "0x0621d647cecbfb64b79e44302c1933cb4f27054d",
    CBK:              "0x4EC203dD0699Fac6adAF483CDd2519BC05D2c573"
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
    const capitalTiers = [".02", ".1", "1", "5000"]; 
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
