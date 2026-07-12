/**  
 * ARBBOT1 - Production Node.js Engine (FIXED)  
 * Network: Polygon (POSIX)  
 */  

import { Wallet, Contract, JsonRpcProvider, WebSocketProvider, parseUnits, formatUnits, getAddress } from "ethers";  

// ==========================================  
// 1. CONFIGURATION & ENVIRONMENT SETUP (FIXED)
// ==========================================  
const CONFIG = {  
    WSS_RPC: "wss://polygon-bor-rpc.publicnode.com",  
    HTTP_RPC: "https://polygon-bor-rpc.publicnode.com",  
    PRIVATE_KEY: process.env.PRIVATE_KEY || "",  
    CONTRACT_ADDRESS: getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc"),  
    USDC_ADDRESS: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
    
    TOKENS: {  
        USDC: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
        WETH: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"),  
        WMATIC: getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),  
        DAI: "0x8f3Cf7aD23Cd3CaDeA96143C01F6f155802654e5a9",  
        USDT: getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F")  
    },  

    ROUTERS: {  
        QUICK_SWAP: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),  
        SUSHI_SWAP: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"),  
        DFYN: "0xA102072AEE07Cccf2a9b78B1E54D1B2aF8f38f3"  
    },  

    BATCH_SIZE_LIMIT: 25,  
    STUCK_TX_TIMEOUT_MS: 8000,  
    MIN_PROFIT_USDC: parseUnits("0", 6), 
    BASE_ARBITRAGE_AMOUNT: parseUnits("0.04", 6), // Fixed to match balance
    CANDIDATE_SIZES: [  
        parseUnits("0.01", 6),  
        parseUnits("0.02", 6),  
        parseUnits("0.04", 6)  
    ]  
};

// ... [Keep your ENFORCER_ABI and ERC20_ABI exactly as they were] ...

// ==========================================  
// 9. CORE BLOCK PROCESSOR (FIXED)
// ==========================================  
async function processBlockMatrix(blockNumber) {  
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} Across Shards...`);  
    
    const contractBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
    
    // FIX: Removed the 'return' statement to allow execution regardless of 'low' balance
    if (contractBalance < CONFIG.BASE_ARBITRAGE_AMOUNT) {  
        console.log(`⚠️ Low vault balance: ${formatUnits(contractBalance, 6)} USDC. Attempting transaction with remaining funds...`);  
    }  
    
    const batches = await generateMatrixPayloads(contractBalance);  
    
    if (batches.length === 0) {  
        console.log("⏳ No profitable batches found in this block.");  
        return;  
    }  
    
    const feeData = await providerHttp.getFeeData();  
    const maxFeePerGas = feeData.gasPrice * 2n;  
    
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {  
        try {  
            const batch = batches[batchIdx];  
            
            // Simulation check remains to prevent wasting gas on guaranteed reverts
            const canExecute = await providerHttp.call({  
                from: wallet.address,  
                to: CONFIG.CONTRACT_ADDRESS,  
                data: enforcerContract.interface.encodeFunctionData("executeFlashBatchArbitrage", [batch]),  
                gasLimit: 5000000  
            }).then(() => true).catch(() => false);  
            
            if (!canExecute) {  
                console.log(`⏭️ Batch #${batchIdx + 1} failed simulation. Skipping.`);  
                continue;  
            }  
            
            const nonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
            const tx = await enforcerContract.executeFlashBatchArbitrage(batch, {  
                nonce: nonce,  
                gasLimit: 5000000,  
                maxFeePerGas: maxFeePerGas,  
                maxPriorityFeePerGas: maxFeePerGas / 10n,  
                type: 2  
            });  
            
            console.log(`✅ Tx sent: ${tx.hash}`);  
            await tx.wait();
        } catch (txError) {  
            console.error(`❌ Batch #${batchIdx + 1} execution error: ${txError.message.slice(0, 50)}`);  
        }  
    }  
}

// ... [Keep all other functions (initialize, setupLogListeners, etc.) the same as your original file] ...
