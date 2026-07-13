/** * ARBBOT1 - Production Node.js Engine (Aave v3 Flash Loan Edition)  
 * Network: Polygon (POSIX)  
 * Architecture: Flash Loan Arbitrage Sequential Executor with Profit Capture  
 * Version: Ethers v6 Direct Modules + ES Modules Compatible  
 */  
import { Wallet, Contract, JsonRpcProvider, WebSocketProvider, parseUnits, formatUnits, getAddress } from "ethers";  

// ==========================================  
// 1. CONFIGURATION & ENVIRONMENT SETUP  
// ==========================================  
const CONFIG = {  
    WSS_RPC: "wss://polygon-bor-rpc.publicnode.com",  
    HTTP_RPC: "https://polygon-bor-rpc.publicnode.com",  
   
    PRIVATE_KEY: process.env.PRIVATE_KEY || "", // MUST be set via env  
   
    CONTRACT_ADDRESS: getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc"),  
    USDC_ADDRESS: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
   
    TOKENS: {  
        USDC: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
        WETH: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"),  
        WMATIC: getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),  
        DAI: "0xA102072A4C07F06EC3B4900FDC4C7B80B6C57429",  
        USDT: getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F")  
    },  
    ROUTERS: {  
        QUICK_SWAP: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),  
        SUSHI_SWAP: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"),  
        DFYN: "0xA102072A4C07F06EC3B4900FDC4C7B80B6C57429"  
    },  
    BATCH_SIZE_LIMIT: 25,  
    STUCK_TX_TIMEOUT_MS: 8000,  
    MIN_PROFIT_USDC: parseUnits("0.000000", 6), // 0 profit threshold (covers cost only)  
    BASE_ARBITRAGE_AMOUNT: parseUnits("500.00", 6), // Increased capital so price discrepancies are visible  
    CANDIDATE_SIZES: [  
        parseUnits("100.00", 6),  
        parseUnits("500.00", 6),  
        parseUnits("1000.00", 6)  
    ]  
};  

// ==========================================  
// 2. FULL CONTRACT ABI DEFINITION  
// ==========================================  
const ENFORCER_ABI = [  
    // --- Batch Execution ---  
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",  
   
    // --- Single Vault Arbitrage ---  
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",  
   
    // --- Flash Loan Single ---  
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",  
   
    // --- Best Size Auto Flash Loan ---  
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",  
   
    // --- Simulation ---  
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC) external view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",  
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] candidateSizes, address[] pathToToken, address[] pathToUSDC) external view returns (uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit)",  
   
    // --- Owner Functions ---  
    "function withdraw(uint256 amount) external",  
    "function setVault(address _newVault) external",  
    "function owner() external view returns (address)",  
    "function vault() external view returns (address)",  
    "function minimumProfitUSDC() external view returns (uint256)",  
   
    // --- ERC20 ---  
    "function balanceOf(address account) external view returns (uint256)",  
   
    // Events  
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"  
];  

const ERC20_ABI = [  
    "function balanceOf(address account) external view returns (uint256)",  
    "function approve(address spender, uint256 amount) external returns (bool)",  
    "function allowance(address owner, address spender) external view returns (uint256)",  
    "function transfer(address recipient, uint256 amount) external returns (bool)"  
];  

// ==========================================  
// 3. GLOBAL STATE  
// ==========================================  
let providerWss;  
let providerHttp;  
let wallet;  
let enforcerContract;  
let usdcContract;  
let currentNonce = -1;  
let isProcessingBlock = false;  
let profitAccumulated = 0n;  
let withdrawThreshold = parseUnits("10", 6); // Auto-withdraw after 10 USDC profit  

// ==========================================  
// 4. INITIALIZATION  
// ==========================================  
async function initialize() {  
    console.log("📡 Connecting Matrix Engine via WebSockets...");  
   
    if (!CONFIG.PRIVATE_KEY || CONFIG.PRIVATE_KEY === "0x0000000000000000000000000000000000000000000000000000000000000000") {  
        throw new Error("❌ Fatal: Valid PRIVATE_KEY must be supplied via environment variable.");  
    }  

    providerHttp = new JsonRpcProvider(CONFIG.HTTP_RPC, undefined, { staticNetwork: true });  
    providerWss = new WebSocketProvider(CONFIG.WSS_RPC, undefined, { staticNetwork: true });  
  
    providerHttp.ens = null;  
    providerWss.ens = null;  
  
    wallet = new Wallet(CONFIG.PRIVATE_KEY, providerHttp);  
    enforcerContract = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);  
    usdcContract = new Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);  
  
    const contractOwner = await enforcerContract.owner();  
    if (contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {  
        console.warn(`⚠️ WARNING: Wallet ${wallet.address} is NOT the contract owner.`);  
    } else {  
        console.log(`✅ Wallet is contract owner. Full access granted.`);  
    }  
  
    currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
  
    const contractBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
    console.log(`🏦 Contract USDC Balance: ${formatUnits(contractBalance, 6)}`);  
   
    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL. Initial Nonce: [${currentNonce}]`);  
  
    setupLogListeners();  
  
    providerWss.on("block", async (blockNumber) => {  
        if (isProcessingBlock) return;  
       
        try {  
            isProcessingBlock = true;  
            await processBlockMatrix(blockNumber);  
        } catch (error) {  
            // Silent drop to maintain stream alignment  
        } finally {  
            isProcessingBlock = false;  
        }  
    });  
  
    console.log("📡 WebSocket Stream Cluster active — awaiting block emissions...\n");  
}  

// ==========================================  
// 5. EVENT LISTENERS  
// ==========================================  
function setupLogListeners() {  
    const contractOnWss = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, providerWss);  
  
    contractOnWss.on("ArbitrageExecuted", async (buyRouter, sellRouter, token, amountInUSDC, beforeBal, afterBal, profitUSDC, event) => {  
        const profitFormatted = formatUnits(profitUSDC, 6);  
        console.log(`💰 ArbitrageExecuted: profit=${profitFormatted} USDC | tx=${event.log.transactionHash.slice(0, 10)}...`);  
       
        profitAccumulated += profitUSDC;  
       
        if (profitAccumulated >= withdrawThreshold) {  
            console.log(`🚀 Profit ${formatUnits(profitAccumulated, 6)} USDC >= threshold. Attempting withdraw...`);  
            await withdrawProfits();  
        }  
    });  
  
    console.log("📊 Event listener attached to WebSocket provider.");  
}  

// ==========================================  
// 6. PROFIT SIMULATION  
// ==========================================  
async function simulatePair(buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC) {  
    try {  
        const [estimatedFinalUSDC, estimatedProfit] = await enforcerContract.simulateArbitrageProfit(  
            buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC  
        );  
        return { estimatedFinalUSDC, estimatedProfit };  
    } catch (error) {  
        return { estimatedFinalUSDC: 0n, estimatedProfit: 0n };  
    }  
}  

// ==========================================  
// 7. MATRIX GENERATION  
// ==========================================  
async function generateMatrixPayloads(availableBalance) {  
    const routerNames = Object.entries(CONFIG.ROUTERS);  
    const tokens = Object.entries(CONFIG.TOKENS);  
    const batches = [];  
  
    let currentBatch = {  
        buyRouters: [],  
        sellRouters: [],  
        amountsInUSDC: [],  
        pathsToToken: [],  
        pathsToUSDC: [],  
        deadline: Math.floor(Date.now() / 1000) + 120  
    };  
  
    let batchCount = 0;  
  
    for (let i = 0; i < routerNames.length; i++) {  
        const [, buyRouter] = routerNames[i];  
       
        for (let j = 0; j < routerNames.length; j++) {  
            if (i === j) continue;  
           
            const [, sellRouter] = routerNames[j];  
           
            for (let t = 0; t < tokens.length; t++) {  
                const [, tokenAddr] = tokens[t];  
                if (tokenAddr === CONFIG.USDC_ADDRESS) continue;  
               
                const amountInUSDC = CONFIG.BASE_ARBITRAGE_AMOUNT;  
                const pathToToken = [CONFIG.USDC_ADDRESS, tokenAddr];  
                const pathToUSDC = [tokenAddr, CONFIG.USDC_ADDRESS];  
               
                const { estimatedProfit } = await simulatePair(  
                    buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC  
                );  
               
                if (estimatedProfit < CONFIG.MIN_PROFIT_USDC) continue;  
               
                currentBatch.buyRouters.push(buyRouter);  
                currentBatch.sellRouters.push(sellRouter);  
                currentBatch.amountsInUSDC.push(amountInUSDC);  
                currentBatch.pathsToToken.push(pathToToken);  
                currentBatch.pathsToUSDC.push(pathToUSDC);  
               
                batchCount++;  
               
                if (batchCount >= CONFIG.BATCH_SIZE_LIMIT) {  
                    batches.push({ ...currentBatch });  
                    currentBatch = {  
                        buyRouters: [],  
                        sellRouters: [],  
                        amountsInUSDC: [],  
                        pathsToToken: [],  
                        pathsToUSDC: [],  
                        deadline: Math.floor(Date.now() / 1000) + 120  
                    };  
                    batchCount = 0;  
                }  
            }  
        }  
    }  
  
    if (batchCount > 0) {  
        batches.push({ ...currentBatch });  
    }  
  
    return batches;  
}  

// ==========================================  
// 8. PROFIT WITHDRAWAL  
// ==========================================  
async function withdrawProfits() {  
    try {  
        const contractBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
       
        if (contractBalance <= 0n) return;  
       
        console.log(`💸 Withdrawing ${formatUnits(contractBalance, 6)} USDC to owner...`);  
       
        const tx = await enforcerContract.withdraw(contractBalance, {  
            gasLimit: 120000,  
            gasPrice: await providerHttp.getFeeData().then(f => f.gasPrice)  
        });  
       
        const receipt = await tx.wait();  
        console.log(`Paperwork confirmed: ${receipt.hash}`);  
       
        profitAccumulated = 0n;  
       
    } catch (error) {  
        console.error(`❌ Withdraw failed: ${error.message}`);  
    }  
}  

// ==========================================  
// 9. CORE BLOCK PROCESSOR (AAVE FLASH LOAN ENGINE)  
// ==========================================  
async function processBlockMatrix(blockNumber) {  
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} via Aave Flash Loan Route...`);  
  
    const mockBalance = parseUnits("10000", 6);  
    const batches = await generateMatrixPayloads(mockBalance);  
  
    if (batches.length === 0) {  
        console.log("⏳ No profitable paths found in this block.\n");  
        return;  
    }  
  
    const feeData = await providerHttp.getFeeData();  
    const maxFeePerGas = feeData.gasPrice * 2n;  
  
    for (let bIdx = 0; bIdx < batches.length; bIdx++) {  
        const batch = batches[bIdx];  
        
        for (let i = 0; i < batch.buyRouters.length; i++) {  
            try {  
                const buyRouter = batch.buyRouters[i];  
                const sellRouter = batch.sellRouters[i];  
                const amountInUSDC = batch.amountsInUSDC[i];  
                const pathToToken = batch.pathsToToken[i];  
                const pathToUSDC = batch.pathsToUSDC[i];  
                const deadline = batch.deadline;  

                console.log(`🚀 Simulating Flash Loan Arbitrage Leg [Asset: ${pathToToken[1].slice(0, 8)}...]`);  
  
                const canExecute = await providerHttp.call({  
                    from: wallet.address,  
                    to: CONFIG.CONTRACT_ADDRESS,  
                    data: enforcerContract.interface.encodeFunctionData("executeAaveFlashLoanArbitrage", [  
                        buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC, deadline  
                    ]),  
                    gasLimit: 3000000  
                }).then(() => true).catch(() => false);  
  
                if (!canExecute) {  
                    console.log(`⏭️ Flash loan path failed simulation. Skipping.`);  
                    continue;  
                }  
  
                const nonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
                console.log(`⚡ Dispatching Aave Flash Loan on Nonce: [${nonce}]`);  
  
                const tx = await enforcerContract.executeAaveFlashLoanArbitrage(  
                    buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC, deadline, {  
                        nonce: nonce,  
                        gasLimit: 3000000,  
                        maxFeePerGas: maxFeePerGas,  
                        maxPriorityFeePerGas: maxFeePerGas / 10n,  
                        type: 2  
                    }  
                );  
  
                console.log(`✅ Flash Loan Tx broadcasted: ${tx.hash}`);  
  
                const receipt = await Promise.race([  
                    tx.wait(),  
                    new Promise((_, reject) =>  
                        setTimeout(() => reject(new Error("TX_TIMEOUT")), CONFIG.STUCK_TX_TIMEOUT_MS)  
                    )  
                ]);  
  
                if (receipt) {  
                    console.log(`✨ Flash execution confirmed in block ${receipt.blockNumber}`);  
                    currentNonce = nonce + 1;  
                    
                    const newBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
                    console.log(`🏦 Current Internal Contract Balance: ${formatUnits(newBalance, 6)} USDC\n`);  
                }  
  
            } catch (txError) {  
                 // Failures captured cleanly here to keep context alignment active
            }  
        }  
    }  
}  

// ==========================================  
// 10. COMMAND LINE INTERFACE  
// ==========================================  
async function main() {  
    const args = process.argv.slice(2);  
    const command = args[0];  

    if (command === "balance") {  
        await initialize();  
        const contractBal = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
        const walletBal = await usdcContract.balanceOf(wallet.address);  
        console.log(`🏦 Contract: ${formatUnits(contractBal, 6)} USDC`);  
        console.log(`👛 Wallet: ${formatUnits(walletBal, 6)} USDC`);  
    } else {  
        console.log("🚀 ARBBOT1 Production Engine Starting...");  
        await initialize();  
  
        // Keep alive  
        process.on("SIGINT", () => process.exit(0));  
        process.on("SIGTERM", () => process.exit(0));  
    }  
}  

main().catch((error) => {  
    console.error("💥 Fatal Error:", error);  
    process.exit(1);  
});
