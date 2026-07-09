/**  
 * ARBBOT1 - Production Node.js Engine (FLASH LOAN MODE)
 * Network: Polygon
 * Architecture: Aave Flash Loan Arbitrage with Pre-Trade Simulation
 */ 

import { Wallet, Contract, JsonRpcProvider, WebSocketProvider, parseUnits, formatUnits, getAddress } from "ethers";  

const CONFIG = {  
    WSS_RPC: "wss://polygon-bor-rpc.publicnode.com",  
    HTTP_RPC: "https://polygon-bor-rpc.publicnode.com",  
    PRIVATE_KEY: process.env.PRIVATE_KEY || "", 
    CONTRACT_ADDRESS: getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc"),  
    USDC_ADDRESS: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
    TOKENS: { WETH: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619") },
    ROUTERS: {  
        QUICK_SWAP: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),  
        SUSHI_SWAP: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506")
    },
    CANDIDATE_SIZES: [parseUnits(".05", 6), parseUnits(".1", 6), parseUnits("10000", 6)],
    GAS_THRESHOLD: parseUnits("0.0005", 6) // Minimum profit required to cover gas/fees
};  

const ENFORCER_ABI = [  
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC) external view returns (uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function owner() external view returns (address)"
];  

const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];  

let wallet, enforcerContract, usdcContract;

async function initialize() {  
    const providerHttp = new JsonRpcProvider(CONFIG.HTTP_RPC);
    const providerWss = new WebSocketProvider(CONFIG.WSS_RPC);
    
    wallet = new Wallet(CONFIG.PRIVATE_KEY, providerHttp);  
    enforcerContract = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);  
    usdcContract = new Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);  

    const contractBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
    
    console.log(`🏦 Contract USDC Balance: ${formatUnits(contractBalance, 6)}`);  
    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL (FLASH LOAN MODE)`);

    providerWss.on("block", async (blockNumber) => {
        await processBlockMatrix(blockNumber);
    });
}

async function processBlockMatrix(blockNumber) {
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber}...`);

    try {
        const best = await enforcerContract.findBestFlashLoanSize(
            CONFIG.ROUTERS.QUICK_SWAP, 
            CONFIG.ROUTERS.SUSHI_SWAP, 
            CONFIG.CANDIDATE_SIZES, 
            [CONFIG.USDC_ADDRESS, CONFIG.TOKENS.WETH], 
            [CONFIG.TOKENS.WETH, CONFIG.USDC_ADDRESS]
        );

        const profitUSDC = formatUnits(best.estimatedProfit, 6);

        if (best.estimatedProfit === 0n) {
            console.log(`⏳ Block #${blockNumber}: No profitable path found.`);
            return;
        }

        console.log(`📊 Simulation: Found opportunity! Expected Profit: ${profitUSDC} USDC`);

        if (best.estimatedProfit > CONFIG.GAS_THRESHOLD) {
            console.log(`🚀 Executing Flash Loan...`);
            
            const tx = await enforcerContract.executeBestFlashLoanArbitrage(
                CONFIG.ROUTERS.QUICK_SWAP, 
                CONFIG.ROUTERS.SUSHI_SWAP, 
                CONFIG.CANDIDATE_SIZES, 
                [CONFIG.USDC_ADDRESS, CONFIG.TOKENS.WETH], 
                [CONFIG.TOKENS.WETH, CONFIG.USDC_ADDRESS], 
                Math.floor(Date.now() / 1000) + 60,
                { gasLimit: 800000 }
            );

            console.log(`✅ Tx sent: ${tx.hash.slice(0, 10)}...${tx.hash.slice(-4)}`);
            const receipt = await tx.wait();
            console.log(`✅ Arbitrage confirmed in block ${receipt.blockNumber}`);
            
            const newBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
            console.log(`💰 Total Contract Balance: ${formatUnits(newBalance, 6)} USDC`);
        } else {
            console.log(`⚠️ Expected profit (${profitUSDC}) too low to cover gas. Skipping.`);
        }
        
    } catch (err) {
        // Silently catch expected reverts during dry runs
    }
}

initialize().catch(console.error);
