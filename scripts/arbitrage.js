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
    }
    return routeMatrix;
}

// ==========================================
// 3. MAIN RUNNER LOOP (With Concurrency Control)
// ==========================================
async function main() {
    console.log("⏳ Initializing Locked Live Prover Script...");
    
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ CRITICAL ERROR: PRIVATE_KEY is missing from your local .env configuration file.");
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
        { buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI, buyName: "QUICK", sellName: "SUSHI" }
    ];

    const amountInUnits = ethers.parseUnits("0.01", 6); 
    
    // Concurrency Lock Variable
    let isExecuting = false;

    provider.on("block", async (blockNumber) => {
        console.log(`\n📦 NEW BLOCK MINED: #${blockNumber} | Processing...`);

        if (isExecuting) {
            console.log("⏳ Execution lock active. Skipping this block scan to prevent collisions.");
            return;
        }

        for (let route of tokenRoutes) {
            for (let pair of routerPairs) {
                try {
                    const contractBalanceBefore = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                    console.log(`📊 [CONTRACT BALANCE BEFORE]: ${ethers.formatUnits(contractBalanceBefore, 6)} USDC`);
                    
                    if (contractBalanceBefore < amountInUnits) {
                        console.error("❌ Test aborted: Insufficient contract balance.");
                        process.exit(1);
                    }

                    // Activate Lock immediately before starting the async transaction call
                    isExecuting = true;
                    console.log(`⚡ SINGLE-BROADCAST LOCK ACQUIRED. Dispatching transaction...`);
                    
                    const txDeadline = Math.floor(Date.now() / 1000) + 60;
                    
                    const tx = await vaultContract.executeArbitrage(
                        pair.buy,
                        pair.sell,
                        amountInUnits,
                        route.pathToToken,
                        route.pathToUSDC,
                        txDeadline,
                        { gasLimit: 250000 }
                    );
                    
                    console.log(`🚨 TRANSACTION HASH DISPATCHED: ${tx.hash}`);
                    console.log(`⏳ Waiting for block confirmation...`);
                    
                    const receipt = await tx.wait(1);
                    console.log(`✅ TRANSACTION SUCCESSFUL IN BLOCK: #${receipt.blockNumber}`);
                    
                    const contractBalanceAfter = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                    console.log(`📊 [CONTRACT BALANCE AFTER]: ${ethers.formatUnits(contractBalanceAfter, 6)} USDC`);
                    
                    console.log("🛑 Prover completed successfully. Shutting down.");
                    process.exit(0);

                } catch (error) {
                    console.error(`❌ Transaction Processing Failed: ${error.message}`);
                    isExecuting = false; // Release lock if a network error occurs
                    process.exit(1);
                }
            }
        }
    });
}

main().catch((error) => {
    console.error("Fatal Runtime Loop Error:", error);
    process.exit(1);
});
