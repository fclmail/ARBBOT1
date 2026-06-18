import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ==========================================
// 1. STABLE HTTP INFRASTRUCTURE
// ==========================================
const RPC_URL = "https://polygon-bor-rpc.publicnode.com";

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const WMATIC_ADDRESS = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const USDT_ADDRESS   = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function generateScanningRoutes() {
    return [
        {
            pathToToken: [USDC_ADDRESS, WMATIC_ADDRESS],
            pathToUSDC: [WMATIC_ADDRESS, USDC_ADDRESS],
            label: "USDC ➡️ WMATIC ➡️ USDC"
        },
        {
            pathToToken: [USDC_ADDRESS, USDT_ADDRESS],
            pathToUSDC: [USDT_ADDRESS, USDC_ADDRESS],
            label: "USDC ➡️ USDT ➡️ USDC"
        }
    ];
}

// ==========================================
// 2. CONTROLLED LOOP RUNNER
// ==========================================
async function main() {
    console.log("🚀 BOT STARTED\n");
    console.log("⏳ Initializing Paced Concurrency Control Engine...\n");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing.");
        process.exit(1);
    }
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    
    const tokenRoutes = generateScanningRoutes();
    const routerPairs = [
        { buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI, buyName: "QUICK", sellName: "SUSHI" },
        { buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK, buyName: "SUSHI", sellName: "QUICK" }
    ];
    const capitalTiers = ["1000", "10000", "50000", "100000", "250000"];

    // Strict state trackers
    let loopBusy = false; 
    let currentBlock = 0;

    // High-precision polling loop running every 500ms
    setInterval(async () => {
        if (loopBusy) return; // Drop execution if previous loop is still processing an RPC request
        loopBusy = true;

        try {
            const freshBlock = await provider.getBlockNumber();
            
            // Only announce and scan if a new block has actually landed
            if (freshBlock > currentBlock) {
                currentBlock = freshBlock;
                console.log(`\n📦 BLOCK: #${currentBlock} | Sequential Matrix Processing Activated...`);

                for (let route of tokenRoutes) {
                    for (let pair of routerPairs) {
                        for (let tier of capitalTiers) {
                            
                            // 50ms pacing safety margin inside the sequential stream
                            await sleep(50); 

                            const testAmountIn = ethers.parseUnits(tier, 6);
                            
                            try {
                                const simulation = await vaultContract.simulateArbitrageProfit(
                                    pair.buy, pair.sell, testAmountIn, route.pathToToken, route.pathToUSDC
                                );

                                const estimatedProfitHuman = parseFloat(ethers.formatUnits(simulation.estimatedProfit, 6));
                                
                                const sizeStr = `$${tier}`.padEnd(7);
                                const dexStr = `${pair.buyName} ➡️ ${pair.sellName}`;
                                const pathStr = `Path: ${route.label}`.padEnd(52);
                                console.log(`   📡 [AUDIT] Size: ${sizeStr} USDC | ${dexStr} | ${pathStr} | Delta: +${estimatedProfitHuman.toFixed(6)} USDC`);

                                // Instant micro-scalper verification trigger 
                                const dynamicMinProfit = 0.000001; 

                                if (estimatedProfitHuman >= dynamicMinProfit) { 
                                    const balanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                                    
                                    if (balanceBefore < testAmountIn) continue;

                                    console.log(`\n🎯 [MATCH FOUND] Tier: ${tier}.00 USDC | Expected Return: +${estimatedProfitHuman.toFixed(6)} USDC`);
                                    console.log(`⚡ LOCK ACQUIRED. Dispatching production transaction...`);
                                    
                                    const txDeadline = Math.floor(Date.now() / 1000) + 30; 
                                    const tx = await vaultContract.executeArbitrage(
                                        pair.buy, pair.sell, testAmountIn, route.pathToToken, route.pathToUSDC, txDeadline,
                                        { 
                                            gasLimit: 500000,
                                            maxFeePerGas: ethers.parseUnits("280", "gwei"),       
                                            maxPriorityFeePerGas: ethers.parseUnits("45", "gwei")  
                                        }
                                    );
                                    
                                    console.log(`🚨 TX DISPATCHED: ${tx.hash}`);
                                    const receipt = await tx.wait(1);
                                    console.log(`✅ CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                                    
                                    const balanceAfter = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                                    console.log(`💰 Realized Net Profit Accumulated: +${ethers.formatUnits(balanceAfter - balanceBefore, 6)} USDC\n`);
                                }
                            } catch (error) {
                                // Gracefully log and skip pool states that return a revert
                                const sizeStr = `$${tier}`.padEnd(7);
                                const dexStr = `${pair.buyName} ➡️ ${pair.sellName}`;
                                console.log(`   📡 [AUDIT] Size: ${sizeStr} USDC | ${dexStr} | Path: ${route.label.padEnd(24)} | Delta: +0.000000 USDC (Reverted State)`);
                            }
                        }
                    }
                }
            }
        } catch (globalError) {
            console.log("⚠️ RPC Endpoint network hiccup encountered. Retrying loop next tick...");
        } finally {
            loopBusy = false; // Open the lock for the next iteration cycle
        }
    }, 500);
}

main().catch((error) => {
    console.error("Fatal Runtime Loop Error:", error);
    process.exit(1);
});
