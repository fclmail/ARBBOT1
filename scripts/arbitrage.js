
/**  
 * ARBBOT1 - Production Node.js Engine (FIXED)  
 * Network: Polygon (POSIX)  
 * Architecture: Vault-Arbitrage Batch Executor with Profit Capture  
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
        DAI: "0x8f3Cf7aD23Cd3CaDeA96143C01F6f155802654e5a9",  
        USDT: getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F")  
    },  

    ROUTERS: {  
        QUICK_SWAP: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),  
        SUSHI_SWAP: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"),  
        DFYN: "0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429"
    },  

    BATCH_SIZE_LIMIT: 25,  
    STUCK_TX_TIMEOUT_MS: 8000,  
    MIN_PROFIT_USDC: parseUnits("0.0000", 6), // Minimum profit threshold  
    BASE_ARBITRAGE_AMOUNT: parseUnits(".04", 6), // Amount per arbitrage leg  
    CANDIDATE_SIZES: [  
        parseUnits(".0100", 6),  
        parseUnits(".0250", 6),  
        parseUnits(".03500", 6),  
        parseUnits(".041000", 6),  
        parseUnits(".0412000", 6)  
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
let txTimeoutTracker = null;  
let profitAccumulated = 0n;  
let withdrawThreshold = parseUnits("10", 6); // Auto-withdraw after 10 USDC profit  
let lastWithdrawBlock = 0;  

// ==========================================  
// 4. INITIALIZATION (FIXED)  
// ==========================================  
async function initialize() {  
    console.log("📡 Connecting Matrix Engine via WebSockets...");  
   
    if (!CONFIG.PRIVATE_KEY || CONFIG.PRIVATE_KEY === "0x0000000000000000000000000000000000000000000000000000000000000000") {  
        throw new Error("❌ Fatal: Valid PRIVATE_KEY must be supplied via environment variable.");  
    }  

    // FIX #2: Create providers with ENS disabled  
    providerHttp = new JsonRpcProvider(CONFIG.HTTP_RPC, undefined, {  
        staticNetwork: true,  // Prevents ENS lookup  
    });  
   
    providerWss = new WebSocketProvider(CONFIG.WSS_RPC, undefined, {  
        staticNetwork: true,  
    });  
   
    // Explicitly disable ENS resolver  
    providerHttp.ens = null;  
    providerWss.ens = null;  
   
    wallet = new Wallet(CONFIG.PRIVATE_KEY, providerHttp);  
    enforcerContract = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);  
    usdcContract = new Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);  

    // Verify ownership  
    const contractOwner = await enforcerContract.owner();  
    if (contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {  
        console.warn(`⚠️ WARNING: Wallet ${wallet.address} is NOT the contract owner.`);  
        console.warn(`   Contract owner is: ${contractOwner}`);  
        console.warn("   Only simulate operations. Withdraw and batch exec will fail.");  
    } else {  
        console.log(`✅ Wallet is contract owner. Full access granted.`);  
    }  

    currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
   
    const contractBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
    console.log(`🏦 Contract USDC Balance: ${formatUnits(contractBalance, 6)}`);  
   
    console.log(`🌐 PRODUCTION MATRIX ENGINE OPERATIONAL. Initial Nonce: [${currentNonce}]`);  

    // Setup event listener (FIX: use WebSocket for reliable filters)  
    setupLogListeners();  

    // Block processing loop  
    providerWss.on("block", async (blockNumber) => {  
        if (isProcessingBlock) {  
            console.log(`⏳ Block #${blockNumber} skipped (previous still processing).`);  
            return;  
        }  
       
        try {  
            isProcessingBlock = true;  
            await processBlockMatrix(blockNumber);  
        } catch (error) {  
            console.error(`❌ Error processing block #${blockNumber}:`, error.message);  
        } finally {  
            isProcessingBlock = false;  
        }  
    });  

    console.log("📡 WebSocket Stream Cluster active — awaiting block emissions...");  
}  

// ==========================================  
// 5. EVENT LISTENERS (FIXED - NO STALE FILTERS)  
// ==========================================  
function setupLogListeners() {  
    // FIX #3: Use WebSocket provider for event subscriptions  
    // This avoids the "filter not found" error on HTTP providers  
   
    const contractOnWss = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, providerWss);  
   
    contractOnWss.on("ArbitrageExecuted", (buyRouter, sellRouter, token, amountInUSDC, beforeBal, afterBal, profitUSDC, event) => {  
        const profitFormatted = formatUnits(profitUSDC, 6);  
        console.log(`💰 ArbitrageExecuted: profit=${profitFormatted} USDC | tx=${event.log.transactionHash.slice(0, 10)}...`);  
       
        // Accumulate profit tracking  
        profitAccumulated += profitUSDC;  
       
        // Auto-withdraw if profit threshold reached  
        if (profitAccumulated >= withdrawThreshold) {  
            console.log(`🚀 Profit ${formatUnits(profitAccumulated, 6)} USDC >= threshold. Attempting withdraw...`);  
            withdrawProfits();  
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
            buyRouter,  
            sellRouter,  
            amountInUSDC,  
            pathToToken,  
            pathToUSDC  
        );  
       
        return { estimatedFinalUSDC, estimatedProfit };  
    } catch (error) {  
        // Simulation might fail on dry run, that's ok  
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
        const [buyName, buyRouter] = routerNames[i];  
       
        for (let j = 0; j < routerNames.length; j++) {  
            if (i === j) continue; // Skip same router pairs  
           
            const [sellName, sellRouter] = routerNames[j];  
           
            for (let t = 0; t < tokens.length; t++) {  
                const [tokenName, tokenAddr] = tokens[t];  
                if (tokenAddr === CONFIG.USDC_ADDRESS) continue; // Skip USDC itself  
               
                const amountInUSDC = CONFIG.BASE_ARBITRAGE_AMOUNT;  
                const pathToToken = [CONFIG.USDC_ADDRESS, tokenAddr];  
                const pathToUSDC = [tokenAddr, CONFIG.USDC_ADDRESS];  
               
                // Simulate to check profitability  
                const { estimatedProfit } = await simulatePair(  
                    buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC  
                );  
               
                if (estimatedProfit < CONFIG.MIN_PROFIT_USDC) continue; // Skip unprofitable  
               
                // Add to current batch  
                currentBatch.buyRouters.push(buyRouter);  
                currentBatch.sellRouters.push(sellRouter);  
                currentBatch.amountsInUSDC.push(amountInUSDC);  
                currentBatch.pathsToToken.push(pathToToken);  
                currentBatch.pathsToUSDC.push(pathToUSDC);  
               
                batchCount++;  
               
                // If batch is full, start a new one  
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
   
    // Push remaining items  
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
       
        if (contractBalance <= 0n) {  
            console.log("⚠️ No USDC in contract to withdraw.");  
            return;  
        }  
       
        console.log(`💸 Withdrawing ${formatUnits(contractBalance, 6)} USDC to owner...`);  
       
        const tx = await enforcerContract.withdraw(contractBalance, {  
            gasLimit: 100000,  
            gasPrice: await providerHttp.getFeeData().then(f => f.gasPrice)  
        });  
       
        const receipt = await tx.wait();  
        console.log(`✅ Withdraw successful: ${receipt.hash}`);  
       
        profitAccumulated = 0n;  
        lastWithdrawBlock = receipt.blockNumber;  
       
    } catch (error) {  
        console.error(`❌ Withdraw failed: ${error.message}`);  
    }  
}  

// ==========================================  
// 9. CORE BLOCK PROCESSOR (FIXED)  
// ==========================================  
async function processBlockMatrix(blockNumber) {  
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} Across Shards...`);  
   
    // Step 1: Check contract USDC balance  
    const contractBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
   
    if (contractBalance < CONFIG.BASE_ARBITRAGE_AMOUNT) {  
        console.log(`⚠️ Low vault balance: ${formatUnits(contractBalance, 6)} USDC. Need funding.`);  
        return;  
    }  
   
    // Step 2: Generate profitable batches  
    const batches = await generateMatrixPayloads(contractBalance);  
   
    if (batches.length === 0) {  
        console.log("⏳ No profitable batches found in this block.");  
        return;  
    }  
   
    // Step 3: Get fresh fee data  
    const feeData = await providerHttp.getFeeData();  
    const maxFeePerGas = feeData.gasPrice * 2n;  
   
    // Step 4: Process each batch sequentially  
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {  
        try {  
            console.log(`🚀 Sending Batch Structure #${batchIdx + 1} to Fastlane Engine via Nonce #${currentNonce}`);  
           
            const batch = batches[batchIdx];  
           
            // FIX #1: Use static call first to verify it will succeed  
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
           
            // FIX #4: Correct nonce management — get fresh nonce for each tx  
            const nonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
           
            const tx = await enforcerContract.executeFlashBatchArbitrage(batch, {  
                nonce: nonce,  
                gasLimit: 5000000,  
                maxFeePerGas: maxFeePerGas,  
                maxPriorityFeePerGas: maxFeePerGas / 10n,  
                type: 2  
            });  
           
            console.log(`✅ Tx sent: ${tx.hash}`);  
           
            // Wait for confirmation with timeout  
            const receipt = await Promise.race([  
                tx.wait(),  
                new Promise((_, reject) =>  
                    setTimeout(() => reject(new Error("TX_TIMEOUT")), CONFIG.STUCK_TX_TIMEOUT_MS)  
                )  
            ]);  
           
            if (receipt) {  
                console.log(`✅ Batch #${batchIdx + 1} confirmed in block ${receipt.blockNumber}`);  
               
                // Update nonce tracker  
                currentNonce = receipt.blockNumber;  
               
                // Check contract balance after execution  
                const newBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
                console.log(`💰 Contract USDC Balance: ${formatUnits(newBalance, 6)}`);  
               
                // Auto-withdraw if enough profit accumulated  
                if (profitAccumulated >= withdrawThreshold) {  
                    console.log(`🎯 Profit threshold hit! Withdrawing ${formatUnits(profitAccumulated, 6)} USDC...`);  
                    await withdrawProfits();  
                }  
            }  
           
        } catch (txError) {  
            if (txError.message === "TX_TIMEOUT") {  
                console.log(`⏰ Batch #${batchIdx + 1} transaction timeout. Moving on.`);  
            } else if (txError.message.includes("replaced") || txError.message.includes("repriced")) {  
                console.log(`🔄 Transaction was replaced/repriced for batch #${batchIdx + 1}. Continuing.`);  
            } else if (txError.message.includes("already known")) {  
                console.log(`📡 Transaction already in mempool for batch #${batchIdx + 1}.`);  
            } else if (txError.message.includes("nonce too low")) {  
                console.log(`🔄 Nonce mismatch. Refreshing nonce...`);  
                currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
            } else if (txError.message.includes("insufficient funds")) {  
                console.log(`💔 Insufficient MATIC for gas. Fund wallet immediately!`);  
                break; // Stop further processing until funded  
            } else {  
                console.error(`❌ Batch #${batchIdx + 1} failed: ${txError.message.slice(0, 200)}`);  
            }  
        }  
    }  
}  

// ==========================================  
// 10. PROFIT CAPTURE VAULT FUNDING PRESET  
// ==========================================  
/*  
 * HOW TO CAPTURE PROFITS & INCREASE CONTRACT BALANCE:  
 *  
 * Problem #1: Contract balance wasn't increasing  
 * Root Cause: The contract starts with 0 USDC. `executeFlashBatchArbitrage`  
 *   uses the contract's own USDC balance as capital. With 0 balance,  
 *   the internal check `batch.amountsInUSDC[i] > usdc.balanceOf(address(this))`  
 *   skips ALL trades. Nothing executes.  
 *  
 * Fix #1: Fund the contract with initial capital  
 *   - Send USDC to the contract address (0xB1a557...4Fcc)  
 *   - Recommend starting capital: 5,000 - 10,000 USDC  
 *   - After each profitable batch, USDC grows inside the contract  
 *  
 * Fix #2: Set vault address if using `executeArbitrage`  
 *   `executeArbitrage` checks `msg.sender == owner || msg.sender == vault`  
 *   Call: `enforcerContract.setVault(vaultAddress)`  
 *   Then vault can call `executeArbitrage` directly  
 *  
 * Problem #2: Profits not withdrawn  
 * Root Cause: The JS only calls `executeFlashBatchArbitrage` which leaves  
 *   all profits in the contract. No separate withdraw call was made.  
 *  
 * Fix #3: Auto-withdraw mechanism (implemented above)  
 *   - `profitAccumulated` tracks profits from events  
 *   - When profit >= `withdrawThreshold` (10 USDC), auto-call `withdraw()`  
 *   - Profits move from contract -> owner wallet  
 *  
 * Problem #3: ENS resolver error  
 * Root Cause: Ethers v6 by default resolves ENS names on every transaction.  
 *   On Polygon, there's no ENS resolver, causing silent failures.  
 *  
 * Fix #4: `staticNetwork: true` in provider options (implemented above)  
 *   - Disables ENS lookups  
 *   - Provider nullifies ENS resolver  
 */  

// ==========================================  
// 11. FUNDING & WITHDRAWAL COMMANDS  
// ==========================================  
async function fundContract(amountUSDC) {  
    console.log(`💸 Funding contract with ${formatUnits(amountUSDC, 6)} USDC...`);  
   
    // Check approval  
    const allowance = await usdcContract.allowance(wallet.address, CONFIG.CONTRACT_ADDRESS);  
    if (allowance < amountUSDC) {  
        console.log("📝 Approving USDC transfer...");  
        const approveTx = await usdcContract.approve(CONFIG.CONTRACT_ADDRESS, amountUSDC);  
        await approveTx.wait();  
        console.log(`✅ Approval tx: ${approveTx.hash}`);  
    }  
   
    // Transfer USDC directly to contract  
    const tx = await usdcContract.transfer(CONFIG.CONTRACT_ADDRESS, amountUSDC);  
    const receipt = await tx.wait();  
    console.log(`✅ Funded: ${receipt.hash}`);  
    console.log(`💰 New contract balance: ${formatUnits(await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS), 6)} USDC`);  
}  

async function emergencyWithdraw(amountUSDC) {  
    const amount = parseUnits(amountUSDC.toString(), 6);  
    console.log(`🚨 Emergency withdraw: ${amountUSDC} USDC...`);  
   
    const tx = await enforcerContract.withdraw(amount);  
    const receipt = await tx.wait();  
    console.log(`✅ Emergency withdraw: ${receipt.hash}`);  
}  

async function withdrawAll() {  
    const balance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
    if (balance > 0n) {  
        await emergencyWithdraw(formatUnits(balance, 6));  
    } else {  
        console.log("No USDC to withdraw.");  
    }  
}  

// ==========================================  
// 12. COMMAND LINE INTERFACE  
// ==========================================  
async function main() {  
    const args = process.argv.slice(2);  
    const command = args[0];  
   
    if (command === "fund" && args[1]) {  
        const amount = parseUnits(args[1], 6);  
        await initialize();  
        await fundContract(amount);  
    } else if (command === "withdraw" && args[1]) {  
        const amount = parseUnits(args[1], 6);  
        await initialize();  
        const tx = await enforcerContract.withdraw(amount);  
        await tx.wait();  
        console.log(`✅ Withdrawn: ${args[1]} USDC`);  
    } else if (command === "withdraw-all") {  
        await initialize();  
        await withdrawAll();  
    } else if (command === "balance") {  
        await initialize();  
        const contractBal = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
        const walletBal = await usdcContract.balanceOf(wallet.address);  
        console.log(`🏦 Contract: ${formatUnits(contractBal, 6)} USDC`);  
        console.log(`👛 Wallet: ${formatUnits(walletBal, 6)} USDC`);  
        console.log(`⛽ MATIC: ${formatUnits(await providerHttp.getBalance(wallet.address), 18)}`);  
    } else if (command === "status") {  
        await initialize();  
        const owner = await enforcerContract.owner();  
        const vault = await enforcerContract.vault();  
        const minProfit = await enforcerContract.minimumProfitUSDC();  
        const contractBal = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
        console.log(`👤 Owner: ${owner}`);  
        console.log(`🏛️ Vault: ${vault}`);  
        console.log(`📉 Min Profit: ${formatUnits(minProfit, 6)} USDC`);  
        console.log(`💰 Contract Balance: ${formatUnits(contractBal, 6)} USDC`);  
        console.log(`👛 Wallet Balance: ${formatUnits(await usdcContract.balanceOf(wallet.address), 6)} USDC`);  
    } else if (command === "set-vault" && args[1]) {  
        await initialize();  
        const tx = await enforcerContract.setVault(getAddress(args[1]));  
        await tx.wait();  
        console.log(`✅ Vault set to: ${args[1]}`);  
    } else {  
        // Default: run the bot  
        console.log("🚀 ARBBOT1 Production Engine Starting...");  
        console.log("Commands:");  
        console.log("  npm start              - Run bot (default)");  
        console.log("  npm run fund <amount>  - Fund contract with USDC");  
        console.log("  npm run withdraw <amt> - Withdraw USDC from contract");  
        console.log("  npm run withdraw-all   - Withdraw all USDC");  
        console.log("  npm run balance        - Check balances");  
        console.log("  npm run status         - Full contract status");  
        console.log("  npm run set-vault <addr> - Set vault address");  
        console.log("");  
       
        await initialize();  
       
        // Keep alive  
        process.on("SIGINT", async () => {  
            console.log("\n🛑 Shutting down...");  
            await withdrawAll();
            process.exit(0);
        });
       
        process.on("SIGTERM", async () => {
            console.log("\n🛑 Terminating...");
            await withdrawAll();
            process.exit(0);
        });
    }
}

main().catch((error) => {
    console.error("💥 Fatal Error:", error);
    process.exit(1);
});



