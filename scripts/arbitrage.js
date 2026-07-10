/**  
 * ARBBOT1 - Production Node.js Engine (FLASH LOAN MODE)
 * Network: Polygon (POSIX)  
 * Architecture: Aave Flash Loan Arbitrage
 */

import { Wallet, Contract, JsonRpcProvider, WebSocketProvider, parseUnits, formatUnits, getAddress } from "ethers";  

const CONFIG = {  
    WSS_RPC: "wss://polygon-bor-rpc.publicnode.com",  
    HTTP_RPC: "https://polygon-bor-rpc.publicnode.com",  
    PRIVATE_KEY: process.env.PRIVATE_KEY || "",
    CONTRACT_ADDRESS: getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc"),  
    USDC_ADDRESS: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
    TOKENS: {
        WETH: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619")
    },
    ROUTERS: {  
        QUICK_SWAP: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),  
        SUSHI_SWAP: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506")
    },
    CANDIDATE_SIZES: [parseUnits("100", 6), parseUnits("500", 6), parseUnits("1000", 6)]  
};  

const ENFORCER_ABI = [  
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",
    "function owner() external view returns (address)"
];  

const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];  

let wallet, enforcerContract, usdcContract;
let lastBalance = BigInt(0); // Track previous balance

async function initialize() {  
    const providerHttp = new JsonRpcProvider(CONFIG.HTTP_RPC);
    const providerWss = new WebSocketProvider(CONFIG.WSS_RPC);
   
    wallet = new Wallet(CONFIG.PRIVATE_KEY, providerHttp);  
    enforcerContract = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);  
    usdcContract = new Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);  

    // Store initial balance
    lastBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
   
    console.log(`🏦 Initial Contract USDC Balance: ${formatUnits(lastBalance, 6)}`);  
    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL (FLASH LOAN MODE)`);

    // Initialize first, then listen to blocks
    providerWss.on("block", async (blockNumber) => {
        await processBlockMatrix(blockNumber);
    });
}

async function processBlockMatrix(blockNumber) {
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} Across Shards...`);

    try {
        // Check current balance before arbitrage
        const balanceBefore = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
        console.log(`💰 Balance before arbitrage: ${formatUnits(balanceBefore, 6)} USDC`);

        console.log(`🚀 Attempting flash loan arbitrage...`);
        
        // Execute the flash loan arbitrage on-chain
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
        console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
       
        // Check balance after arbitrage
        const balanceAfter = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);
        const profit = balanceAfter - lastBalance;
        const currentProfit = balanceAfter - balanceBefore;
       
        console.log(`💰 Previous balance: ${formatUnits(lastBalance, 6)} USDC`);
        console.log(`💰 Current balance: ${formatUnits(balanceAfter, 6)} USDC`);
        console.log(`📈 Total profit: ${formatUnits(profit, 6)} USDC`);
        console.log(`📈 This trade profit: ${formatUnits(currentProfit, 6)} USDC`);
       
        // Update last balance
        lastBalance = balanceAfter;
       
    } catch (err) {
        // Contract reverts if no profitable path - this is normal
        // But let's log it for debugging
        if (err.code === 'CALL_EXCEPTION') {
            console.log(`⏭️ No profitable arbitrage found in block ${blockNumber}`);
        } else {
            console.error(`❌ Error: ${err.message}`);
        }
    }
}

initialize().catch(console.error);
