import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ==========================================
// 1. HARDCODED NETWORK & SMART CONTRACT CONFIG
// ==========================================
const RPC_URL = "https://polygon.drpc.org";
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

// ==========================================
// 2. ROUTE GENERATION
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
// 3. MAIN RUNNER LOOP (Production Configuration)
// ==========================================
async function main() {
    console.log("⏳ Initializing Locked Production Engine...");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY is missing from your .env configuration file.");
        process.exit(1);
    }
    const PRIVATE_KEY = process.env.PRIVATE_KEY;

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const startBlock = await provider.getBlockNumber();
    console.log(`\n🟢 CONNECTED | Active on Polygon Block: #${startBlock}`);

    const tokenRoutes = generateScanningRoutes();
    const routerPairs = [
        { buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI, buyName: "QUICK", sellName: "SUSHI" },
        { buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK, buyName: "SUSHI", sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.QUICK, buyName: "DFYN",  sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.APE,   buyName: "DFYN",  sellName: "APE" }
    ];

    // ADJUSTABLE: Standard production capital tier size
    const amountInUnits = ethers.parseUnits("0.05", 6); 
    
    let isExecuting = false;

    provider.on("block", async (blockNumber) => {
        console.log(`📦 BLOCK: #${blockNumber} | Scanning Matrix Routes...`);

        if (isExecuting) {
            console.log("⏳ Execution lock active. Skipping this block scan to prevent collisions.");
            return;
        }

        for (let route of tokenRoutes) {
            for (let pair of routerPairs) {
                try {
                    // Query the on-chain simulation engine
                    const simulation = await vaultContract.simulateArbitrageProfit(
                        pair.buy,
                        pair.sell,
                        amountInUnits,
                        route.pathToToken,
                        route.pathToUSDC
                    );

                    const estimatedProfit = simulation.estimatedProfit;
                    const estimatedProfitHuman = parseFloat(ethers.formatUnits(estimatedProfit, 6));

                    // =================================================================
                    // PRODUCTION FILTER: Only fires transaction if true profit is verified
                    // =================================================================
                    if (estimatedProfitHuman > 0.000001) { 
                        const contractBalanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        
                        if (contractBalanceBefore < amountInUnits) {
                            console.error(`❌ Opportunity found, but contract lacks required capital size.`);
                            continue;
                        }

                        // Activate concurrency lock
                        isExecuting = true;
                        console.log(`💰 [PROFIT MATCH DETECTED]. Delta Calculation: +${estimatedProfitHuman.toFixed(6)} USDC`);
                        console.log(`[DEX PATH]: ${pair.buyName} (${route.label}) ➡️ ${pair.sellName}`);
                        console.log(`⚡ LOCK ACQUIRED. Dispatching production transaction...`);
                        
                        const txDeadline = Math.floor(Date.now() / 1000) + 30; // 30s expiration limit
                        
                        const tx = await vaultContract.executeArbitrage(
                            pair.buy,
                            pair.sell,
                            amountInUnits,
                            route.pathToToken,
                            route.pathToUSDC,
                            txDeadline,
                            { gasLimit: 400000 }
                        );
                        
                        console.log(`🚨 TRANSACTION HASH DISPATCHED: ${tx.hash}`);
                        const receipt = await tx.wait(1);
                        console.log(`✅ CONFIRMED IN BLOCK: #${receipt.blockNumber}`);
                        
                        const contractBalanceAfter = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        const netProfitRealized = contractBalanceAfter - contractBalanceBefore;
                        console.log(`💰 Realized Net Profit: +${ethers.formatUnits(netProfitRealized, 6)} USDC`);
                        
                        // Release lock for subsequent block evaluations
                        isExecuting = false;
                    }
                } catch (error) {
                    // Suppress expected simulation reverts to keep runtime clean
                    if (error.message && !error.message.includes("execution reverted")) {
                        console.log(`⚠️ Simulation Exception: ${error.message}`);
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
