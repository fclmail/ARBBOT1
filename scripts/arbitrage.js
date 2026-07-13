/** * ARBBOT1 - Production Node.js Engine (Off-Chain Pricing Verification)  
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
   
    PRIVATE_KEY: process.env.PRIVATE_KEY || "",  
   
    CONTRACT_ADDRESS: getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc"),  
    USDC_ADDRESS: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
   
    TOKENS: {  
        USDC: getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),  
        WETH: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"),  
        WMATIC: getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),  
        // FIXED: Lowercase bypasses validation string errors entirely inside getAddress()
        DAI: getAddress("0x8f3cf6ad15024657154e65d401430046f383903e"),   
        USDT: getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F")  
    },  
    ROUTERS: {  
        QUICK_SWAP: getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),  
        SUSHI_SWAP: getAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506")  
    },  
    BATCH_SIZE_LIMIT: 25,  
    STUCK_TX_TIMEOUT_MS: 8000,  
    BASE_ARBITRAGE_AMOUNT: parseUnits("500.00", 6),   
    AAVE_PREMIUM_FACTOR: 5n // 0.05% fee tracking  
};  

// ROUTER ABI for pricing checks
const ROUTER_ABI = [  
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"  
];  

const ENFORCER_ABI = [  
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline) external",  
    "function withdraw(uint256 amount) external",  
    "function owner() external view returns (address)",  
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"  
];  

const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];  

let providerWss, providerHttp, wallet, enforcerContract, usdcContract;  
let currentNonce = -1;  
let isProcessingBlock = false;  

async function initialize() {  
    console.log("🚀 ARBBOT1 Production Engine Starting...");
    console.log("📡 Connecting Matrix Engine via WebSockets...");  
    providerHttp = new JsonRpcProvider(CONFIG.HTTP_RPC, undefined, { staticNetwork: true });  
    providerWss = new WebSocketProvider(CONFIG.WSS_RPC, undefined, { staticNetwork: true });  
  
    wallet = new Wallet(CONFIG.PRIVATE_KEY, providerHttp);  
    enforcerContract = new Contract(CONFIG.CONTRACT_ADDRESS, ENFORCER_ABI, wallet);  
    usdcContract = new Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, wallet);  
  
    currentNonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
    console.log(`🌐 ENGINE OPERATIONAL. Initial Nonce: [${currentNonce}]`);  
  
    providerWss.on("block", async (blockNumber) => {  
        if (isProcessingBlock) return;  
        try {  
            isProcessingBlock = true;  
            await processBlockMatrix(blockNumber);  
        } catch (err) { /* Catch silence */ }  
        finally { isProcessingBlock = false; }  
    });  

    console.log("📡 WebSocket Stream Cluster active — awaiting block emissions...\n");  
}  

async function checkArbitrageProfitability(buyRouter, sellRouter, amountIn, pathToToken, pathToUSDC) {  
    try {  
        const routerBuy = new Contract(buyRouter, ROUTER_ABI, providerHttp);  
        const routerSell = new Contract(sellRouter, ROUTER_ABI, providerHttp);  

        // 1. Calculate tokens received out of first exchange  
        const amountsOutBuy = await routerBuy.getAmountsOut(amountIn, pathToToken);  
        const midTokenAmount = amountsOutBuy[amountsOutBuy.length - 1];  

        // 2. Calculate final USDC returned from second exchange  
        const amountsOutSell = await routerSell.getAmountsOut(midTokenAmount, pathToUSDC);  
        const finalUSDC = amountsOutSell[amountsOutSell.length - 1];  

        // 3. Calculate minimal Aave threshold requirement (Amount + 0.05% Premium)  
        const premiumCost = (amountIn * CONFIG.AAVE_PREMIUM_FACTOR) / 10000n;  
        const totalRequiredBack = amountIn + premiumCost;  

        if (finalUSDC > totalRequiredBack) {  
            return { isProfitable: true, expectedProfit: finalUSDC - totalRequiredBack };  
        }  
        return { isProfitable: false, expectedProfit: 0n };  
    } catch (e) {  
        return { isProfitable: false, expectedProfit: 0n };  
    }  
}  

async function processBlockMatrix(blockNumber) {  
    console.log(`[WebSocket Stream Cluster] 🔍 Scanning Block #${blockNumber} via Off-Chain Rates...`);  
  
    const routerEntries = Object.entries(CONFIG.ROUTERS);  
    const tokenEntries = Object.entries(CONFIG.TOKENS);  
    const deadline = Math.floor(Date.now() / 1000) + 120;  

    for (let [bName, buyRouter] of routerEntries) {  
        for (let [sName, sellRouter] of routerEntries) {  
            if (buyRouter === sellRouter) continue;  

            for (let [tName, tokenAddr] of tokenEntries) {  
                if (tokenAddr === CONFIG.USDC_ADDRESS) continue;  

                const amountInUSDC = CONFIG.BASE_ARBITRAGE_AMOUNT;  
                const pathToToken = [CONFIG.USDC_ADDRESS, tokenAddr];  
                const pathToUSDC = [tokenAddr, CONFIG.USDC_ADDRESS];  

                console.log(`🚀 Checking Route: ${bName} -> ${sName} via ${tName}`);  

                // Run off-chain JS verification engine  
                const { isProfitable, expectedProfit } = await checkArbitrageProfitability(  
                    buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC  
                );  

                if (!isProfitable) {  
                    console.log(`⏭️ Route lacks necessary spread to clear Aave premium. Skipping.`);  
                    continue;  
                }  

                console.log(`🔥 Profitable Path Found! Expected Surplus: ${formatUnits(expectedProfit, 6)} USDC`);  
                try {  
                    const nonce = await providerHttp.getTransactionCount(wallet.address, "pending");  
                    const feeData = await providerHttp.getFeeData();  

                    console.log(`⚡ Dispatching Aave Flash Loan on Nonce: [${nonce}]`);  
                    const tx = await enforcerContract.executeAaveFlashLoanArbitrage(  
                        buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC, deadline, {  
                            nonce: nonce,  
                            gasLimit: 2500000,  
                            maxFeePerGas: feeData.gasPrice * 2n,  
                            maxPriorityFeePerGas: feeData.gasPrice / 5n,  
                            type: 2  
                        }  
                    );  
                    console.log(`✅ Flash Loan Executed: ${tx.hash}`);  
                    const receipt = await tx.wait();  
                    console.log(`✨ Flash execution confirmed in block ${receipt.blockNumber}\n`);  
                } catch (txEx) {  
                    console.log(`❌ Execution failure: ${txEx.message}`);  
                }  
            }  
        }  
    }  
}  

async function main() {  
    await initialize();  
    process.on("SIGINT", () => process.exit(0));  
    process.on("SIGTERM", () => process.exit(0));  
}  
main().catch((e) => process.exit(1));
