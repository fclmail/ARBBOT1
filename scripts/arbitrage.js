/**  
 * ARBBOT1 - Production Node.js Engine (FIXED & VERIFIED)  
 * Network: Polygon (POSIX)  
 * Architecture: Vault-Arbitrage Batch Executor with Real-Balance Profit Verification  
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
        TOKENA: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        TOKENB: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
        TOKENC: "0x3BA4c387f786bFEE076A58914F5Bd38d668B42c3",
        TOKEND: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
        TOKENE: "0xd93f7e271cb87c23aaa73edc008a79646d1f9912",
        TOKENF: "0x06d02e9d62a13fc76bb229373fb3bbbd1101d2fc",
        TOKENG: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
        TOKENH: "0xf854225caaef5a722884a68a23215dfa5386751e",
        TOKENI: "0xb0897686c545045afc77cf20ec7a532e3120e0f1",
        TOKENJ: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
        TOKENK: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
        TOKENL: "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8",
        TOKENM: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
        TOKENN: "0x99af3eea856556646c98c8b9b2548fe815240750",
        TOKENO: "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b",
        TOKENP: "0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
        TOKENQ: "0x2893Ef551B6dD69F661Ac00F11D93E5Dc5Dc0e99",
        TOKENR: "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec",
        TOKENS: "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
        TOKENT: "0x553d3d295e0f695b9228246232edf400ed3560b5",
        TOKENU: "0xffa4d863c96e743a2e1513824ea006b8d0353c57",
        TOKENV: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
        TOKENW: "0xa0769f7a8fc65e47de93797b4e21c073c117fc80",
        TOKENX: "0x61299774020da444af134c82fa83e3810b309991",
        TOKENY: "0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
        TOKENZ: "0x0266F4F08D82372CF0FcbCCc0Ff74309089c74d1",

        TOKENAA: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
        TOKENAB: "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
        TOKENAC: "0x4e8dc2149eac3f3def36b1c281ea466338249371",
        TOKENAD: "0x7583feddbcefa813dc18259940f76a02710a8905",
        TOKENAE: "0x172370d5cd63279efa6d502dab29171933a610af",
        TOKENAF: "0xc3c7d422809852031b44ab29eec9f1eff2a58756",
        TOKENAG: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
        TOKENAH: "0x5ffd62d3c3ee2e81c00a7b9079fb248e7df024a8",
        TOKENAI: "0x6985884c4392d348587b19cb9eaaf157f13271cd",
        TOKENAJ: "0xcb059c5573646047d6d88dddb87b745c18161d3b",
        TOKENAK: "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
        TOKENAL: "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",
        TOKENAM: "0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6",
        TOKENAN: "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a",
        TOKENAO: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
        TOKENAP: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
        TOKENAQ: "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
        TOKENAR: "0xf1938ce12400f9a761084e7a80d37e732a4da056",
        TOKENAS: "0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
        TOKENAT: "0xe4880249745eac5f1ed9d8f7df844792d560e750",
        TOKENAU: "0x67ce67ec4fcd4aca0fcb738dd080b2a21ff69d75",
        TOKENAV: "0xB7b31a6BC18e48888545CE79e83E06003bE70930",
        TOKENAW: "0xb46e0ae620efd98516f49bb00263317096c114b2",
        TOKENAX: "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
        TOKENAY: "0x50b728d8d964fd00c2d0aad81718b71311fef68a",
        TOKENAZ: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",

        TOKENBA: "0x3cef98bb43d732e2f285ee605a8158cde967d219",
        TOKENBB: "0x43eDD7f3831b08FE70B7555ddD373C8bF65a9050",
        TOKENBC: "0xee327f889d5947c1dc1934bb208a1e792f953e96",
        TOKENBD: "0xFCe60bBc52a5705CeC5B445501FBAf3274Dc43D0",
        TOKENBE: "0xf1815bd50389c46847f0bda824ec8da914045d14",
        TOKENBF: "0x80eede496655fb9047dd39d9f418d5483ed600df",
        TOKENBG: "0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
        TOKENBH: "0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
        TOKENBI: "0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
        TOKENBJ: "0xf50d05a1402d0adafa880d36050736f9f6ee7dee",
        TOKENBK: "0x3Ec3849C33291a9eF4c5dB86De593EB4A37fDe45",
        TOKENBL: "0x6d1fdbb266fcc09a16a22016369210a15bb95761",
        TOKENBM: "0xda537104d6a5edd53c6fbba9a898708e465260b6",
        TOKENBN: "0x3962f4a0a0051dcce0be73a7e09cef5756736712",
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
    MIN_PROFIT_USDC: parseUnits("0.00001", 6), // Minimum profit threshold  
    BASE_ARBITRAGE_AMOUNT: parseUnits(".02", 6), // Amount per arbitrage leg  
    CANDIDATE_SIZES: [  
        parseUnits("100", 6),  
        parseUnits("250", 6),  
        parseUnits("500", 6),  
        parseUnits("1000", 6),  
        parseUnits("2000", 6)  
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
let lastWithdrawBlock = 0;  

// ==========================================  
// 4. INITIALIZATION (FIXED)  
// ==========================================  
async function initialize() {  
    console.log("📡 Connecting Matrix Engine via WebSockets...");  
     
    if (!CONFIG.PRIVATE_KEY || CONFIG.PRIVATE_KEY === "0x0000000000000000000000000000000000000000000000000000000000000000") {  
        throw new Error("❌ Fatal: Valid PRIVATE_KEY must be supplied via environment variable.");  
    }  

    providerHttp = new JsonRpcProvider(CONFIG.HTTP_RPC, undefined, {  
        staticNetwork: true,  
    });  
     
    providerWss = new WebSocketProvider(CONFIG.WSS_RPC, undefined, {  
        staticNetwork: true,  
    });  
     
    providerHttp.ens = null;  
    providerWss.ens = null;  
     
    wallet = new Wallet(CONFIG.PRIVATE_KEY, providerHttp);  
    enforcerContract = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);  
    usdcContract = new Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);  

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

    setupLogListeners();  

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
// 5. EVENT LISTENERS  
// ==========================================  
function setupLogListeners() {  
    const contractOnWss = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, providerWss);  
     
    contractOnWss.on("ArbitrageExecuted", (buyRouter, sellRouter, token, amountInUSDC, beforeBal, afterBal, profitUSDC, event) => {  
        const profitFormatted = formatUnits(profitUSDC, 6);  
        console.log(`💰 ArbitrageExecuted Event: profit=${profitFormatted} USDC | tx=${event.log.transactionHash.slice(0, 10)}...`);  
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
            if (i === j) continue;   
             
            const [sellName, sellRouter] = routerNames[j];  
             
            for (let t = 0; t < tokens.length; t++) {  
                const [tokenName, tokenAddr] = tokens[t];  
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
// 9. CORE BLOCK PROCESSOR (WITH REAL BALANCE VERIFICATION)  
// ==========================================  
async function processBlockMatrix(blockNumber) {  
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} Across Shards...`);  
     
    const contractBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
     
    if (contractBalance < CONFIG.BASE_ARBITRAGE_AMOUNT) {  
        console.log(`⚠️ Low vault balance: ${formatUnits(contractBalance, 6)} USDC. Need funding.`);  
        return;  
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
            console.log(`🚀 Sending Batch Structure #${batchIdx + 1} to Fastlane Engine via Nonce #${currentNonce}`);  
             
            const batch = batches[batchIdx];  
             
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
             
            // MEASURE BALANCE BEFORE EXECUTION  
            const beforeBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  

            const tx = await enforcerContract.executeFlashBatchArbitrage(batch, {  
                nonce: nonce,  
                gasLimit: 5000000,  
                maxFeePerGas: maxFeePerGas,  
                maxPriorityFeePerGas: maxFeePerGas / 10n,  
                type: 2  
            });  
             
            console.log(`✅ Tx sent: ${tx.hash}`);  
             
            const receipt = await Promise.race([  
                tx.wait(),  
                new Promise((_, reject) =>   
                    setTimeout(() => reject(new Error("TX_TIMEOUT")), CONFIG.STUCK_TX_TIMEOUT_MS)  
                )  
            ]);  
             
            if (receipt) {  
                console.log(`✅ Batch #${batchIdx + 1} confirmed in block ${receipt.blockNumber}`);  
                 
                currentNonce = receipt.blockNumber;  
                 
                // MEASURE BALANCE AFTER EXECUTION TO GET TRUE REALIZED PROFIT  
                const afterBalance = await usdcContract.balanceOf(CONFIG.CONTRACT_ADDRESS);  
                const realizedProfit = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0n;  

                console.log(`💰 Contract USDC Balance: ${formatUnits(afterBalance, 6)}`);  
                console.log(`📈 Real On-Chain Profit Realized: ${formatUnits(realizedProfit, 6)} USDC`);  

                profitAccumulated += realizedProfit;  
                 
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
                break;  
            } else {  
                console.error(`❌ Batch #${batchIdx + 1} failed: ${txError.message.slice(0, 200)}`);  
            }  
        }  
    }  
}  

// ==========================================  
// 10. FUNDING & WITHDRAWAL COMMANDS  
// ==========================================  
async function fundContract(amountUSDC) {  
    console.log(`💸 Funding contract with ${formatUnits(amountUSDC, 6)} USDC...`);  
     
    const allowance = await usdcContract.allowance(wallet.address, CONFIG.CONTRACT_ADDRESS);  
    if (allowance < amountUSDC) {  
        console.log("📝 Approving USDC transfer...");  
        const approveTx = await usdcContract.approve(CONFIG.CONTRACT_ADDRESS, amountUSDC);  
        await approveTx.wait();  
        console.log(`✅ Approval tx: ${approveTx.hash}`);  
    }  
     
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
// 11. COMMAND LINE INTERFACE  
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
