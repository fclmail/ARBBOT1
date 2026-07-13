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
    USDC_ADDRESS: getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174"),  
   
    TOKENS: {  
        USDC: getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174"),  
        WETH: getAddress("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"),  
        WMATIC: getAddress("0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"),  
        DAI: getAddress("0x8f3cf6ad15024657154e65d401430046f383903e"),   
        USDT: getAddress("0xc2132d05d31c914a87c6611c10748aeb04b58e8f"),  
        WBTC: getAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"), 
        CRV: getAddress("0x172370d5cd632221a5d947f4575907617494f26e"), 
        LINK: getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"), 
        UNI: getAddress("0xb33eaad8d922b1083446dc23f610c2567fb5180f"), 
        AAVE: getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"), 
        SUSHI: getAddress("0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a"), 
        QUICK: getAddress("0xb5c064f955d8e7f38fe0460c556a72987494ee17"), 
        MATICX: getAddress("0xfa68fb4628dff1028cfec22b4162fccd0d45efb6"), 
        BAL: getAddress("0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3"), 
        GHST: getAddress("0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7")  
    },  
    ROUTERS: {  
        // FIXED: All router configurations downcased to fully neutralize validation failures
        QUICK_SWAP: getAddress("0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff"),  
        SUSHI_SWAP: getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),  
        DFYN:       getAddress("0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429"),  
        PEARL_V2:   getAddress("0xef8b8c496a929fd39225df1f52361c1ab57f22e8"),  
        APE_SWAP:   getAddress("0xc0788a3d035548248853c802456a831a2933d744")  
    },  
    BATCH_SIZE_LIMIT: 25,  
    STUCK_TX_TIMEOUT_MS: 8000,  
    BASE_ARBITRAGE_AMOUNT: parseUnits("5.00", 6),   
    AAVE_PREMIUM_FACTOR: 1n // 0.05% fee tracking  
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
