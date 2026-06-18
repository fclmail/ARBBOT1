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

// Top liquidity pairs pulled from your asset cluster
const TOKENS = {
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
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

// Parallel scan batch size setting to optimize HTTP pipeline
const BATCH_SIZE = 4; 

// ==========================================
// 2. TRIANGULAR PATH GENERATION MATRICES
// ==========================================
function buildTriangularPaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];

    for (const a of tokenAddresses) {
        for (const b of tokenAddresses) {
            if (a === b) continue;
            generatedPaths.push({
                fullPath: [USDC_ADDRESS, a, b, USDC_ADDRESS],
                pathToToken: [USDC_ADDRESS, a, b],
                pathToUSDC: [b, USDC_ADDRESS],
                label: `USDC ➡️ ${a.slice(0, 6)}... ➡️ ${b.slice(0, 6)}... ➡️ USDC`
            });
        }
    }
    return generatedPaths;
}

// ==========================================
// 3. MAIN RUNNER (Paced Control Loop)
// ==========================================
async function main() {
    console.log("🚀 BOT STARTED WITH TRIANGULAR LOOKUPS (PARALLELIZED)\n");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing.");
        process.exit(1);
    }
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const routerContracts = {
        QUICK: new ethers.Contract(ROUTERS.QUICK, ROUTER_ABI, provider),
        SUSHI: new ethers.Contract(ROUTERS.SUSHI, ROUTER_ABI, provider)
    };
    
    const triangularPaths = buildTriangularPaths();
    const capitalTiers = ["1000", "10000", "50000", "100000"];

    let loopBusy = false; 
    let currentBlock = 0;

    setInterval(async () => {
        if (loopBusy) return; 
        loopBusy = true;

        try {
            const freshBlock = await provider.getBlockNumber();
            
            if (freshBlock > currentBlock) {
                currentBlock = freshBlock;
                console.log(`\n📦 BLOCK: #${currentBlock} | Auditing Triangular Flow Matrices...`);

                // Break up checking into parallel promise chunks to eliminate nested loop latency
                for (let i = 0; i < triangularPaths.length; i += BATCH_SIZE) {
                    const pathChunk = triangularPaths.slice(i, i + BATCH_SIZE);
                    const scanPromises = [];

                    for (let pathObj of pathChunk) {
                        for (let routerKey of Object.keys(routerContracts)) {
                            for (let tier of capitalTiers) {
                                const testAmountIn = ethers.parseUnits(tier, 6);
                                const activeRouterContract = routerContracts[routerKey];
                                
                                // Push simulation task to parallel pool execution queue
                                scanPromises.push(
                                    activeRouterContract.getAmountsOut(testAmountIn, pathObj.fullPath)
                                        .then(amountsOut => {
                                            const finalAmountOut = amountsOut[amountsOut.length - 1];
                                            const profit = finalAmountOut - testAmountIn;
                                            const profitHuman = parseFloat(ethers.formatUnits(profit, 6));

                                            return {
                                                success: true,
                                                routerKey,
                                                tier,
                                                profitHuman,
                                                testAmountIn,
                                                pathObj
                                            };
                                        })
                                        .catch(() => ({ success: false }))
                                );
                            }
                        }
                    }

                    // Execute current chunk in parallel over the HTTP endpoint
                    const results = await Promise.all(scanPromises);
                    let executionTriggered = false;

                    for (const res of results) {
                        if (!res.success) continue;

                        const sizeStr = `$${res.tier}`.padEnd(7);
                        const routerStr = `${res.routerKey.padEnd(5)}`;
                        console.log(`   📡 [AUDIT] Size: ${sizeStr} USDC | Router: ${routerStr} | Delta: +${res.profitHuman.toFixed(6)} USDC`);

                        const dynamicMinProfit = 0.0001; 

                        if (res.profitHuman >= dynamicMinProfit && !executionTriggered) { 
                            const balanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                            if (balanceBefore < res.testAmountIn) continue;

                            executionTriggered = true; // Lock execution during this block cycle
                            console.log(`\n🎯 [TRIANGULAR MATCH] Profit Target Cleared: +${res.profitHuman.toFixed(6)} USDC`);
                            console.log(`⚡ Dispatching transaction onto ${res.routerKey}...`);
                            
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
                                    gasLimit: 600000,
                                    maxFeePerGas: ethers.parseUnits("280", "gwei"),       
                                    maxPriorityFeePerGas: ethers.parseUnits("45", "gwei")  
                                }
                            );
                            
                            console.log(`🚨 TX DISPATCHED: ${tx.hash}`);
                            const receipt = await tx.wait(1);
                            console.log(`✅ CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                            
                            const balanceAfter = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                            console.log(`💰 Realized Net Profit: +${ethers.formatUnits(balanceAfter - balanceBefore, 6)} USDC\n`);
                            break; 
                        }
                    }

                    // Small structural sleep between batch processing chunks to protect public node socket connections
                    await sleep(40);
                    if (executionTriggered) break; 
                }
            }
        } catch (globalError) {
            console.log("⚠️ Connection interruption caught. Resetting loop index state...");
        } finally {
            loopBusy = false; 
        }
    }, 500);
}

main().catch((error) => {
    console.error("Fatal Runtime Loop Error:", error);
    process.exit(1);
});
