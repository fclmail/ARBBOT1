import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ==========================================
// 1. STABLE HTTP INFRASTRUCTURE & SETTINGS
// ==========================================
const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
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
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];
const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)"
];
const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (x) => ethers.formatUnits(x, 6);
const BATCH_SIZE = 4;

// ==========================================
// 2. ROUTER QUOTE MEMORY CACHING SYSTEM (JS1)
// ==========================================
const quoteCache = new Map();
const CACHE_TTL = 1000; // 1 second validity

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

// ==========================================
// 3. JS1 SEQUENTIAL MULTI-HOP QUOTER 
// ==========================================
async function getSequentialTriangularQuote(routerContract, amountIn, path) {
    const routerAddr = routerContract.target;

    // Hop 1: USDC -> Token A
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

    // Hop 2: Token A -> Token B
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

    // Hop 3: Token B -> USDC
    const path3 = [path[2], path[3]];
    let out3 = getCachedQuote(routerAddr, path3);
    if (out3 === undefined) {
        try {
            const res = await routerContract.getAmountsOut(out2, path3);
            out3 = res[res.length - 1];
            setCachedQuote(routerAddr, path3, out3);
        } catch { setCachedQuote(routerAddr, path3, null); return null; }
    }
    return out3; // Final finalAmountOut in USDC
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

// ==========================================
// 4. MAIN RUNNER (Parallel Scanner & Control Loop)
// ==========================================
async function main() {
    console.log("🚀 BOT STARTED - ENHANCED ENGINE LOADED\n");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing.");
        process.exit(1);
    }
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const routerContracts = {
        QUICK: new ethers.Contract(ROUTERS.QUICK, ROUTER_ABI, provider),
        SUSHI: new ethers.Contract(ROUTERS.SUSHI, ROUTER_ABI, provider)
    };
    
    const triangularPaths = buildTriangularPaths();
    
    // Updated Trade Amounts as specified
    const capitalTiers = ["0.01", "0.10", "1", "10", "100", "1000"];

    let loopBusy = false; 
    let currentBlock = 0;

    setInterval(async () => {
        if (loopBusy) return; 
        loopBusy = true;

        try {
            const freshBlock = await provider.getBlockNumber();
            if (freshBlock > currentBlock) {
                currentBlock = freshBlock;
                console.log(`\n📦 BLOCK: #${currentBlock} | Auditing Chains via Cached Sequential Pipelines...`);

                for (let i = 0; i < triangularPaths.length; i += BATCH_SIZE) {
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

                        // Filter out empty outputs or near-zero data noise
                        if (res.displayDelta === "-0.000000" || res.displayDelta === "+0.000000") continue;

                        console.log(`   📡 [AUDIT] Size: $${res.tier.padEnd(6)} USDC | Router: ${res.routerKey.padEnd(5)} | Delta: ${res.displayDelta} USDC`);

                        // Updated to exactly 0.00001 floor threshold as requested
                        const minProfitFloor = 0.00001; 

                        if (res.isProfitable && res.profitHuman >= minProfitFloor && !executionTriggered) { 
                            const balanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                            if (balanceBefore < res.testAmountIn) continue;

                            executionTriggered = true; 
                            console.log(`\n🎯 [MATCH FOUND] Profitable Sequence Confirmed: ${res.displayDelta} USDC`);
                            
                            const targetRouterAddress = ROUTERS[res.routerKey];
                            const txDeadline = Math.floor(Date.now() / 1000) + 30; 
                            
                            const tx = await vaultContract.executeArbitrage(
                                targetRouterAddress, 
                                targetRouterAddress, 
                                res.testAmountIn, 
                                res.pathObj.pathToToken, 
                                res.pathObj.pathToUSDC, 
                                txDeadline,
                                { 
                                    gasLimit: 550000,
                                    maxFeePerGas: ethers.parseUnits("250", "gwei"),       
                                    maxPriorityFeePerGas: ethers.parseUnits("40", "gwei")  
                                }
                            );
                            
                            console.log(`🚨 TX DISPATCHED: ${tx.hash}`);
                            await tx.wait(1);
                            console.log(`✅ BATCH BLOCK CONFIRMED`);
                            break; 
                        }
                    }
                    if (executionTriggered) break;
                }
            }
        } catch (globalError) {
            console.log("⚠️ RPC Pipeline drop handled cleanly. Advancing...");
        } finally {
            loopBusy = false; 
        }
    }, 500);
}

main().catch((error) => {
    console.error("Fatal Execution Fault:", error);
    process.exit(1);
});
