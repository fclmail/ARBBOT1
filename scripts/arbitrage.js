import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ==========================================
// 1. STABLE PRODUCTION ENDPOINT
// ==========================================
const RPC_URL = "https://polygon-bor-rpc.publicnode.com";

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS  = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const WMATIC_ADDRESS = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const USDT_ADDRESS   = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const WBTC_ADDRESS   = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    DFYN:  "0xf17b5936699a3232363837bc45cd031553456574",
    APE:   "0xc0788a3d33aa7a816f74d957ce64415f33333333" 
};

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================================
// 2. OPTIMIZED ROUTE GRID GENERATION
// ==========================================
function getTokenLabel(address) {
    switch(address.toLowerCase()) {
        case USDC_ADDRESS.toLowerCase(): return "USDC";
        case WMATIC_ADDRESS.toLowerCase(): return "WMATIC";
        case USDT_ADDRESS.toLowerCase(): return "USDT";
        case WBTC_ADDRESS.toLowerCase(): return "WBTC";
        default: return "UNKNOWN";
    }
}

function generateScanningRoutes() {
    const intermediates = [WMATIC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS];
    let routeMatrix = [];
    for (let intermediate of intermediates) {
        routeMatrix.push({
            pathToToken: [USDC_ADDRESS, intermediate],
            pathToUSDC: [intermediate, USDC_ADDRESS],
            label: `USDC ➡️ ${getTokenLabel(intermediate)} ➡️ USDC`
        });
        for (let secondIntermediate of intermediates) {
            if (intermediate.toLowerCase() !== secondIntermediate.toLowerCase()) {
                routeMatrix.push({
                    pathToToken: [USDC_ADDRESS, intermediate, secondIntermediate],
                    pathToUSDC: [secondIntermediate, USDC_ADDRESS],
                    label: `USDC ➡️ ${getTokenLabel(intermediate)} ➡️ ${getTokenLabel(secondIntermediate)} ➡️ USDC`
                });
            }
        }
    }
    return routeMatrix;
}

// ==========================================
// 3. MAIN RUNNER (High-Speed Matrix)
// ==========================================
async function main() {
    console.log("🚀 BOT STARTED\n");
    console.log("⏳ Initializing High-Speed Matrix Engine...\n");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY missing from your .env file.");
        process.exit(1);
    }
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    
    const startBlock = await provider.getBlockNumber();
    console.log(`🟢 CONNECTED | Active Endpoint: (${RPC_URL}) | Block: #${startBlock}`);

    const tokenRoutes = generateScanningRoutes();
    const routerPairs = [
        { buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI, buyName: "QUICK", sellName: "SUSHI" },
        { buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK, buyName: "SUSHI", sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.QUICK, buyName: "DFYN ",  sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.APE,   buyName: "DFYN ",  sellName: "APE  " }
    ];

    const capitalTiers = ["1000", "10000", "50000", "100000", "250000"];
    let isExecuting = false;

    provider.on("block", async (blockNumber) => {
        console.log(`\n📦 BLOCK: #${blockNumber} | Auditing Matrix Across Capital Depth Tiers...`);
        if (isExecuting) return;

        // Flatten checks to process high-liquidity pairings quickly
        for (let route of tokenRoutes) {
            for (let pair of routerPairs) {
                for (let tier of capitalTiers) {
                    if (isExecuting) break;

                    // Reduced pacing footprint to match the processing capacity of public nodes
                    await sleep(35); 

                    const testAmountIn = ethers.parseUnits(tier, 6);
                    
                    try {
                        const simulation = await vaultContract.simulateArbitrageProfit(
                            pair.buy,
                            pair.sell,
                            testAmountIn,
                            route.pathToToken,
                            route.pathToUSDC
                        );

                        const estimatedProfit = simulation.estimatedProfit;
                        const estimatedProfitHuman = parseFloat(ethers.formatUnits(estimatedProfit, 6));

                        const sizeStr = `$${tier}`.padEnd(7);
                        const dexStr = `${pair.buyName} ➡️ ${pair.sellName}`;
                        const pathStr = `Path: ${route.label}`.padEnd(52);
                        console.log(`   📡 [AUDIT] Size: ${sizeStr} USDC | ${dexStr} | ${pathStr} | Delta: +${estimatedProfitHuman.toFixed(6)} USDC`);

                        // Execution Targets
                        let dynamicMinProfit = 0.00001; 
                        if (testAmountIn >= ethers.parseUnits("250000", 6)) dynamicMinProfit = 10.0;
                        else if (testAmountIn >= ethers.parseUnits("100000", 6)) dynamicMinProfit = 1.00;
                        else if (testAmountIn >= ethers.parseUnits("50000", 6)) dynamicMinProfit = 0.1;
                        else if (testAmountIn >= ethers.parseUnits("10000", 6)) dynamicMinProfit = 0.0001;
                        else if (testAmountIn >= ethers.parseUnits("1000", 6)) dynamicMinProfit = 0.0001;

                        if (estimatedProfitHuman >= dynamicMinProfit) { 
                            const contractBalanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                            
                            if (contractBalanceBefore < testAmountIn) {
                                continue;
                            }

                            isExecuting = true;
                            console.log(`\n🎯 [DYNAMIC MATCH FOUND] Sizer Selected Bracket: ${tier}.00 USDC | Expected Return: +${estimatedProfitHuman.toFixed(6)} USDC`);
                            console.log(`⚡ LOCK ACQUIRED. Dispatching production transaction...`);
                            
                            const txDeadline = Math.floor(Date.now() / 1000) + 30; 
                            const tx = await vaultContract.executeArbitrage(
                                pair.buy,
                                pair.sell,
                                testAmountIn,
                                route.pathToToken,
                                route.pathToUSDC,
                                txDeadline,
                                { gasLimit: 450000 }
                            );
                            
                            console.log(`🚨 TRANSACTION HASH DISPATCHED: ${tx.hash}`);
                            const receipt = await tx.wait(1);
                            console.log(`✅ CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                            
                            const contractBalanceAfter = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                            console.log(`💰 Realized Net Profit: +${ethers.formatUnits(contractBalanceAfter - contractBalanceBefore, 6)} USDC\n`);
                            
                            isExecuting = false;
                            break; 
                        }
                    } catch (error) {
                        let errorMsg = "";
                        if (error.message && error.message.includes("execution reverted")) {
                            errorMsg = " (Reverted Block State)";
                        } else if (error.message) {
                            errorMsg = ` (${error.message.slice(0, 20)})`;
                        }
                        
                        const sizeStr = `$${tier}`.padEnd(7);
                        const dexStr = `${pair.buyName} ➡️ ${pair.sellName}`;
                        const pathStr = `Path: ${route.label}`.padEnd(52);
                        console.log(`   📡 [AUDIT] Size: ${sizeStr} USDC | ${dexStr} | ${pathStr} | Delta: +0.000000 USDC${errorMsg}`);
                    }
                }
            }
        }
    });
}

main().catch((error) => {
    console.error("Fatal Runtime Loop Error:", error);
    process.exit(1);
});
