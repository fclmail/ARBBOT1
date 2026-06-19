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

const ENFORCER_ABI = [
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external returns (uint256)"
];
const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)"
];
const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BATCH_SIZE = 4;

const quoteCache = new Map();
const CACHE_TTL = 1000; 

function getCachedQuote(routerAddress, path) {
    const key = `${routerAddress}-${path.join('-')}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.value;
    }
    return undefined;
}

function setCachedQuote(routerAddress, path, value) {
    const key = `${routerAddress}-${path.join('-')}`;
    quoteCache.set(key, { value, timestamp: Date.now() });
    if (quoteCache.size > 50000) {
        const now = Date.now();
        for (const [k, entry] of quoteCache) {
            if (now - entry.timestamp > CACHE_TTL) quoteCache.delete(k);
        }
    }
}

async function getSequentialTriangularQuote(routerContract, amountIn, path) {
    const routerAddr = routerContract.target;
    const path1 = [path[0], path[1]];
    let out1 = getCachedQuote(routerAddr, path1);
    if (out1 === undefined) {
        try {
            const res = await routerContract.getAmountsOut(amountIn, path1);
            out1 = res[res.length - 1];
            setCachedQuote(routerAddr, path1, out1);
        } catch { setCachedQuote(routerAddr, path1, null); return null; }
    }
    if (!out1) return null;

    const path2 = [path[1], path[2]];
    let out2 = getCachedQuote(routerAddr, path2);
    if (out2 === undefined) {
        try {
            const res = await routerContract.getAmountsOut(out1, path2);
            out2 = res[res.length - 1];
            setCachedQuote(routerAddr, path2, out2);
        } catch { setCachedQuote(routerAddr, path2, null); return null; }
    }
    if (!out2) return null;

    const path3 = [path[2], path[3]];
    let out3 = getCachedQuote(routerAddr, path3);
    if (out3 === undefined) {
        try {
            const res = await routerContract.getAmountsOut(out2, path3);
            out3 = res[res.length - 1];
            setCachedQuote(routerAddr, path3, out3);
        } catch { setCachedQuote(routerAddr, path3, null); return null; }
    }
    return out3; 
}

function buildTriangularPaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];
    for (const a of tokenAddresses) {
        for (const b of tokenAddresses) {
            if (a === b) continue;
            generatedPaths.push({
                fullPath: [USDC_ADDRESS, a, b, USDC_ADDRESS],
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
const routerContracts = {};
let isReconnecting = false;

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

    routerContracts.QUICK = new ethers.Contract(ROUTERS.QUICK, ROUTER_ABI, provider);
    routerContracts.SUSHI = new ethers.Contract(ROUTERS.SUSHI, ROUTER_ABI, provider);

    ws.on("close", () => {
        currentEndpointIndex = (currentEndpointIndex + 1) % WSS_ENDPOINTS.length;
        onDisconnect();
    });
}

async function main() {
    if (isReconnecting) return;
    
    console.log("🚀 BOT STARTED - ENHANCED WSS EVENT ENGINE LOADED");
    
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
    const triangularPaths = buildTriangularPaths();
    const capitalTiers = ["0.01", "0.10", "1", "10", "100", "1000"];

    provider.on("block", async (freshBlock) => {
        if (blockProcessingActive || isReconnecting) return; 
        blockProcessingActive = true;

        console.log(`\n⚡ LIVE BLOCK DETECTED VIA WSS: #${freshBlock} | Scanning Matrix Pipelines...`);

        try {
            const currentVaultBalance = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);

            for (let i = 0; i < triangularPaths.length; i += BATCH_SIZE) {
                if (isReconnecting) break;
                const pathChunk = triangularPaths.slice(i, i + BATCH_SIZE);
                const scanPromises = [];

                for (let pathObj of pathChunk) {
                    for (let routerKey of Object.keys(routerContracts)) {
                        for (let tier of capitalTiers) {
                            const testAmountIn = ethers.parseUnits(tier, 6);
                            const activeRouterContract = routerContracts[routerKey];
                            
                            scanPromises.push(
                                getSequentialTriangularQuote(activeRouterContract, testAmountIn, pathObj.fullPath)
                                    .then(finalAmountOut => {
                                        if (!finalAmountOut) return { success: false };
                                        
                                        const isProfitable = finalAmountOut > testAmountIn;
                                        const profitDelta = isProfitable ? finalAmountOut - testAmountIn : 0n;
                                        const lossDelta = !isProfitable ? testAmountIn - finalAmountOut : 0n;
                                        
                                        return {
                                            success: true,
                                            routerKey,
                                            tier,
                                            isProfitable,
                                            displayDelta: isProfitable 
                                                ? `+${ethers.formatUnits(profitDelta, 6)}` 
                                                : `-${ethers.formatUnits(lossDelta, 6)}`,
                                            profitHuman: parseFloat(ethers.formatUnits(profitDelta, 6)),
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
                    console.log(`${logColor}   📡 [AUDIT] Size: $${res.tier.padEnd(6)} USDC | Router: ${res.routerKey.padEnd(5)} | Delta: ${res.displayDelta} USDC${RESET}`);

                    const minProfitFloor = 0.00001; 
                    
                    // FIX 1: Decoupled relative tier evaluation check to support real dynamic absolute gains
                    const isPhantomData = res.profitHuman > 25000.0; 

                    if (res.isProfitable && res.profitHuman >= minProfitFloor && !isPhantomData && !executionTriggered) { 
                        // FIX 2: Dynamic sizing based on contract accumulation state
                        let executionAmount = res.testAmountIn;
                        if (currentVaultBalance > 0n && currentVaultBalance > res.testAmountIn) {
                            executionAmount = currentVaultBalance;
                        }

                        if (currentVaultBalance < executionAmount) continue;

                        executionTriggered = true; 
                        console.log(`${GREEN}\n🎯 [MATCH FOUND] Profitable Sequence Confirmed: ${res.displayDelta} USDC${RESET}`);
                        
                        const targetRouterAddress = ROUTERS[res.routerKey];
                        const txDeadline = Math.floor(Date.now() / 1000) + 30; 
                        
                        const tx = await vaultContract.executeArbitrage(
                            targetRouterAddress, 
                            targetRouterAddress, 
                            executionAmount, 
                            res.pathObj.pathToToken, 
                            res.pathObj.pathToUSDC, 
                            txDeadline,
                            { 
                                gasLimit: 600000,
                                maxFeePerGas: ethers.parseUnits("280", "gwei"),       
                                maxPriorityFeePerGas: ethers.parseUnits("45", "gwei")  
                            }
                        );
                        
                        console.log(`🚨 TX DISPATCHED: ${tx.hash}`);
                        
                        const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("Tx Timeout")), ms));
                        try {
                            const receipt = await Promise.race([tx.wait(1), timeout(14000)]);
                            console.log(`✅ BATCH BLOCK CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                        } catch (err) {
                            console.log("⚠️ RPC Pipeline drop handled cleanly. Advancing...");
                        }
                        break; 
                    }
                }
                if (executionTriggered) break;
            }
        } catch (globalError) {
            // Drop errors cleanly without stopping script loop execution execution path pipelines
        } finally {
            blockProcessingActive = false; 
        }
    });
}

main().catch((error) => {
    console.error("Fatal Execution Fault:", error);
    process.exit(1);
});
