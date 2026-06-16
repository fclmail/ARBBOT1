const { ethers } = require("ethers");
require("dotenv").config();

// ==========================================
// 1. CONFIGURATION & ECOSYSTEM ENV ADDRESSES
// ==========================================
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_CONTRACT_ADDRESS = process.env.VAULT_CONTRACT_ADDRESS; // Your VaultArbitrageEnforcer deployment

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDT_ADDRESS = "0xc2132D05D31c914a87C6611c10748AEb04B58e8F";
const WBTC_ADDRESS = "0x1BFD62B7D67757592390627d7d4b26ec554a758F";

// Known Router Deployments on Polygon
const ROUTERS = {
    QUICK: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SUSHI: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    DFYN:  "0xF17b5936699a3232363837bc45cd031553456574",
    APE:   "0xC0788A3D33aA7A816F74D957CE64415f33333333" // Example placeholder router target
};

// Minimal ABIs required for execution monitoring
const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

// ==========================================
// 2. ROUTE GENERATION MATRIX (MULTI-HOP)
// ==========================================
function getTokenLabel(address address) {
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
        // Direct Pathing: USDC -> Intermediate -> USDC
        routeMatrix.push({
            pathToToken: [USDC_ADDRESS, intermediate],
            pathToUSDC: [intermediate, USDC_ADDRESS],
            label: `USDC ➡️ ${getTokenLabel(intermediate)} ➡️ USDC`
        });

        // Combinatorial Multi-Hop Mixes: USDC -> Intermediate A -> Intermediate B -> USDC
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
// 3. MAIN RUNTIME PROCESSING ENGINE
// ==========================================
async function main() {
    console.log("⏳ Initializing Vault-Funded Processing Engine...");
    
    if (!RPC_URL || !PRIVATE_KEY || !VAULT_CONTRACT_ADDRESS) {
        console.error("❌ Critical variables missing inside environments.");
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const currentBlock = await provider.getBlockNumber();
    console.log(`🟢 CONNECTED → Vault Engine Active on Polygon Block: #${currentBlock}`);
    console.log(`🚀 MULTI-DEX BOT ACTIVE [VAULT CAPITAL INJECTION ENGINE]`);

    const tokenRoutes = generateScanningRoutes();
    const routerPairs = [
        { buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI, buyName: "QUICK", sellName: "SUSHI" },
        { buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK, buyName: "SUSHI", sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.QUICK, buyName: "DFYN",  sellName: "QUICK" },
        { buy: ROUTERS.DFYN,  sell: ROUTERS.APE,   buyName: "DFYN",  sellName: "APE" }
    ];

    // Setup input unit sizes for simulation (e.g., scanning at 100 USDC scales)
    const amountInUnits = ethers.utils.parseUnits("100", 6); 

    // Listen continuously for newly mined blockchain states
    provider.on("block", async (blockNumber) => {
        console.log(`\n📦 NEW BLOCK MINED: #${blockNumber} | SCANNING FOR OPPORTUNITIES...`);
        let opportunitiesFoundThisBlock = 0;

        for (let route of tokenRoutes) {
            for (let pair of routerPairs) {
                try {
                    // Call View Simulation function on contract
                    const simulation = await vaultContract.simulateArbitrageProfit(
                        pair.buy,
                        pair.sell,
                        amountInUnits,
                        route.pathToToken,
                        route.pathToUSDC
                    );

                    const estimatedProfit = simulation.estimatedProfit;
                    const estimatedProfitHuman = parseFloat(ethers.utils.formatUnits(estimatedProfit, 6));

                    // FIX: Ensure only strict positive arbitrage triggers execution
                    if (estimatedProfitHuman > 0) {
                        opportunitiesFoundThisBlock++;
                        console.log(`💰 INTERNAL MATCH FOUND. Delta Calculation: +${estimatedProfitHuman.toFixed(6)} USDC`);
                        console.log(`[DEX PATH]: ${pair.buyName} (${route.label}) ➡️ ${pair.sellName}`);
                        
                        // Extract and output explicit contract context before deploying capital
                        const contractBalanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        console.log(`📊 [CONTRACT BALANCE BEFORE]: ${ethers.utils.formatUnits(contractBalanceBefore, 6)} USDC`);
                        console.log(`⚡ DISPATCHING VAULT CAPITAL FOR LIVE SWAP...`);

                        const txDeadline = Math.floor(Date.now() / 1000) + 60; // 1-minute tx validity
                        
                        const tx = await vaultContract.executeArbitrage(
                            pair.buy,
                            pair.sell,
                            amountInUnits,
                            route.pathToToken,
                            route.pathToUSDC,
                            txDeadline,
                            { gasLimit: 450000 }
                        );

                        const receipt = await tx.wait();
                        console.log(`✅ Transaction completed successfully in block: #${receipt.blockNumber}`);

                        const contractBalanceAfter = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        console.log(`📊 [CONTRACT BALANCE AFTER]: ${ethers.utils.formatUnits(contractBalanceAfter, 6)} USDC`);
                        
                        const netProfitRealized = contractBalanceAfter.sub(contractBalanceBefore);
                        console.log(`💰 Realized Profit: +${ethers.utils.formatUnits(netProfitRealized, 6)} USDC`);
                    }
                } catch (error) {
                    // Failures or normal reverts cleanly log execution exceptions
                    console.log(`❌ Transaction completed execution but reverted on-chain.`);
                    try {
                        const balanceChecked = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                        console.log(`📊 [CONTRACT BALANCE STAYED]: ${ethers.utils.formatUnits(balanceChecked, 6)} USDC`);
                    } catch (err) {
                        // Silent catch if connection drops briefly during catch balance parsing
                    }
                }
            }
        }

        if (opportunitiesFoundThisBlock === 0) {
            console.log(`⏱️ Scan Finished. No valid profitable routing paths found in this block.`);
        }
    });
}

main().catch((error) => {
    console.error("Fatal Runtime Loop Error:", error);
    process.exit(1);
});
