import { ethers } from "ethers";

// ==========================================
// CONFIGURATION & CONFIG CONSTANTS
// ==========================================
const PROVIDER_RPC = "https://polygon-rpc.com"; 
const CONTRACT_ADDRESS = "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958";

// Target token definition (USDC on Polygon utilizes 6 decimals)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS = 6;

// Safely pull the private key from environment secrets
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Target Batch Sizing Condition
const TARGET_BATCH_SIZE = 3; 

// ABI containing required methods and balance checking capabilities
const CONTRACT_ABI = [
    "function executeFlashBatchArbitrage(tuple(address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function minimumProfitUSDC() public view returns (uint256)"
];

const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)"
];

// ==========================================
// BATCH MANAGER (QUEUE STATE)
// ==========================================
let currentBatch = {
    buyRouters: [],
    sellRouters: [],
    amountsInUSDC: [],
    pathsToToken: [],
    pathsToUSDC: [],
    deadline: 0
};

let queuedRouteLogs = [];

/**
 * Adds an arbitrage route to the memory queue. 
 * Fires execution immediately once targeted batch volume is hit.
 */
async function queueArbitrageRoute(route, contractWithSigner) {
    console.log(`[Queue] Staging path: ${route.label || 'Unnamed Route'}`);
    
    // Normalize and checksum check all incoming route addresses to avoid validation crashes
    const safeBuyRouter = ethers.getAddress(route.buyRouter);
    const safeSellRouter = ethers.getAddress(route.sellRouter);
    const safePathToToken = route.pathToToken.map(addr => ethers.getAddress(addr));
    const safePathToUSDC = route.pathToUSDC.map(addr => ethers.getAddress(addr)); // FIXED: Using correct singular property

    // Simulate the on-chain profit view for this specific route right now
    let estimatedProfitFormatted = "0.00";
    try {
        const [, estimatedProfit] = await contractWithSigner.simulateArbitrageProfit(
            safeBuyRouter,
            safeSellRouter,
            route.amountInUSDC,
            safePathToToken,
            safePathToUSDC
        );
        estimatedProfitFormatted = ethers.formatUnits(estimatedProfit, USDC_DECIMALS);
    } catch (simError) {
        estimatedProfitFormatted = "Simulation Reverted (Check Liquidity/Pools)";
    }

    // Keep track of the simulated status parameters for the eventual execution log summary
    queuedRouteLogs.push({
        index: currentBatch.buyRouters.length + 1,
        buyRouter: safeBuyRouter,
        sellRouter: safeSellRouter,
        amountIn: ethers.formatUnits(route.amountInUSDC, USDC_DECIMALS),
        simulatedProfit: estimatedProfitFormatted
    });

    currentBatch.buyRouters.push(safeBuyRouter);
    currentBatch.sellRouters.push(safeSellRouter);
    currentBatch.amountsInUSDC.push(route.amountInUSDC);
    currentBatch.pathsToToken.push(safePathToToken);
    currentBatch.pathsToUSDC.push(safePathToUSDC); // FIXED: Linked cleanly to safe local collection variable
    
    if (currentBatch.buyRouters.length >= TARGET_BATCH_SIZE) {
        console.log(`\n🚀 [Batch Target Reached] Target size of ${TARGET_BATCH_SIZE} hit! Processing execution log summary...`);
        await executeQueuedBatch(contractWithSigner);
    } else {
        console.log(`[Queue Status] Accumulated: ${currentBatch.buyRouters.length}/${TARGET_BATCH_SIZE} paths.\n`);
    }
}

/**
 * Fires the transaction on-chain and resets the memory tracker variables
 */
async function executeQueuedBatch(contractWithSigner) {
    const provider = contractWithSigner.provider;
    const usdcContract = new ethers.Contract(ethers.getAddress(USDC_ADDRESS), ERC20_ABI, provider);
    
    try {
        // 1. Log the individual batch items and their simulated individual execution parameters
        console.log("====================================================================");
        console.log("                   BATCH ARBITRAGE PROFILE REPORT                   ");
        console.log("====================================================================");
        queuedRouteLogs.forEach((item) => {
            console.log(`Path #${item.index}:`);
            console.log(`  • Buy Router:      ${item.buyRouter}`);
            console.log(`  • Sell Router:     ${item.sellRouter}`);
            console.log(`  • Input Size:      ${item.amountIn} USDC`);
            console.log(`  • Expected Profit: ${item.simulatedProfit} USDC`);
            console.log("--------------------------------------------------------------------");
        });

        // 2. Query contract wallet states prior to dispatching transaction payload
        const balanceBefore = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        console.log(`[Balance State] Enforcer Balance BEFORE Batch execution: ${ethers.formatUnits(balanceBefore, USDC_DECIMALS)} USDC`);

        currentBatch.deadline = Math.floor(Date.now() / 1000) + 120; // 2 minutes execution window

        console.log("[Tx] Dispatching array bundle structure to executeFlashBatchArbitrage...");
        const tx = await contractWithSigner.executeFlashBatchArbitrage(currentBatch, {
            gasLimit: 2000000 // Multi-hop batch execution requires an intentional step-up ceiling
        });
        
        console.log(`[Tx Sent] Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`🎉 [Tx Confirmed] Batch transaction validated in block ${receipt.blockNumber}`);
        
        // 3. Query contract wallet states following blockchain state mutation
        const balanceAfter = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        console.log(`[Balance State] Enforcer Balance AFTER Batch execution:  ${ethers.formatUnits(balanceAfter, USDC_DECIMALS)} USDC`);
        
        const change = balanceAfter - balanceBefore;
        if (change > 0n) {
            console.log(`📈 [Net Delta] Dynamic Balance Growth Captured: +${ethers.formatUnits(change, USDC_DECIMALS)} USDC`);
        } else {
            console.log(`📉 [Net Delta] No net positive balance adjustments captured (Trades skipped or broken internally).`);
        }
        
    } catch (error) {
        console.error("❌ [Execution Failed] Batch processing error or explicit evm revert triggered:", error.reason || error.message);
    } finally {
        resetBatchQueue();
    }
}

function resetBatchQueue() {
    currentBatch = {
        buyRouters: [],
        sellRouters: [],
        amountsInUSDC: [],
        pathsToToken: [],
        pathsToUSDC: []
    };
    queuedRouteLogs = [];
    console.log("====================================================================");
    console.log("[Queue] Memory pipeline structures flushed and reset for next batch.\n");
}

// ==========================================
// CORE EXECUTION ENTRYPOINT
// ==========================================
async function main() {
    if (!PRIVATE_KEY || PRIVATE_KEY.includes("YOUR_PRIVATE_KEY")) {
        throw new Error("Missing process.env.PRIVATE_KEY. Check your GitHub Repository Secrets environment setup.");
    }

    const provider = new ethers.JsonRpcProvider(PROVIDER_RPC);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(ethers.getAddress(CONTRACT_ADDRESS), CONTRACT_ABI, wallet);

    console.log(`Initializing Arbitrage Enforcer Client Engine...`);
    console.log(`Network Target:  Polygon Mainnet`);
    console.log(`Contract Target: ${ethers.getAddress(CONTRACT_ADDRESS)}`);
    
    // RESTORED: Query and log minimum profit target setting configured on-chain
    try {
        const minProfit = await contract.minimumProfitUSDC();
        console.log(`Contract Filter: Minimum required profit per trade: ${ethers.formatUnits(minProfit, USDC_DECIMALS)} USDC`);
    } catch (err) {
        console.log(`Contract Filter: Could not fetch minimumProfitUSDC (Check contract deploy state)`);
    }
    
    console.log(`Batch Threshold: ${TARGET_BATCH_SIZE} collected items\n`);

    // --- MOCK REPLICATED DETECTED OPPORTUNITIES DATASET ---
    const sampleDiscoveredRoutes = [
        {
            label: "USDC -> WETH -> USDC (QuickSwap to Sushi)",
            buyRouter: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", 
            sellRouter: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", 
            amountInUSDC: ethers.parseUnits("1000", USDC_DECIMALS), 
            pathToToken: ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"], 
            pathToUSDC: ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"]  
        },
        {
            label: "USDC -> USDT -> USDC (QuickSwap to Sushi)",
            buyRouter: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
            sellRouter: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
            amountInUSDC: ethers.parseUnits("2500", USDC_DECIMALS),
            pathToToken: ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"], 
            pathToUSDC: ["0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"]  
        },
        {
            label: "USDC -> DAI -> USDC (Sushi to QuickSwap)",
            buyRouter: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
            sellRouter: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
            amountInUSDC: ethers.parseUnits("5000", USDC_DECIMALS),
            pathToToken: ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0x8f3cf6ad23cd3ead96143c01f6f15580230cc746"], 
            pathToUSDC: ["0x8f3cf6ad23cd3ead96143c01f6f15580230cc746", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"]  
        }
    ];

    for (const route of sampleDiscoveredRoutes) {
        await queueArbitrageRoute(route, contract);
    }
}

main().catch(console.error);
