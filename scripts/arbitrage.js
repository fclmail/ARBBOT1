// ============================================================================  
// arbitrage.js — Hyper-Optimized Dynamic Optimization Matrix
// ============================================================================  

import { ethers } from "ethers";  

// ===================== CONFIGURATION =====================  
const CONFIG = {  
    // STRATEGY 7: Multi-RPC Architecture Array
    rpcUrls: [
        process.env.RPC_URL || "https://polygon-rpc.com",
        "https://polygon-bor-rpc.publicnode.com",
        "https://1rpc.io/matic"
    ],
    wsUrl: process.env.WS_URL || "wss://polygon-bor-rpc.publicnode.com",  
      
    contractAddress: "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958",  
    minimumNetProfitUSDC: 100000n, // $0.10 minimum net profit required to trigger execution
    polPriceUSDC: 0.55,           // Mocked asset dollar price for gas translation matrices
      
    maxPendingTxs: 3,  
    gasLimit: 4000000n, 
    priorityFee: ethers.parseUnits("50", "gwei"),  
};  

const TOKEN_SELECTORS = {  
    WETH:   1,  
    WMATIC: 2,  
    USDT:   3,  
    DAI:    4,  
    WBTC:   5  
};  

const TOKENS = {
    USDC:   "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    DAI:    "0x8f3cf7ad23cdcadbd9735aff958023239c6a063",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const DEXES = {  
    QuickSwap:    "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",  
    SushiSwap:    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",  
    ApeSwap:      "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607"
};  

const ROUTERS = Object.values(DEXES);  
const DEX_NAMES = Object.keys(DEXES);
const TOKEN_NAMES = Object.keys(TOKEN_SELECTORS);

// STRATEGY 1: Bridge Asset Declarations
const BRIDGES = [TOKENS.WETH, TOKENS.WMATIC, TOKENS.USDT, TOKENS.DAI];

const CONTRACT_ABI = [  
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external"
];  

class RealTimeArbitrageBot {  
    constructor() {  
        this.pendingTxs = new Map();  
        this.currentBlockNumber = 0;  
        this.providers = [];
        this.activeProviderIndex = 0;
        this.quoteCache = new Map(); // STRATEGY 6: Memory Cache Ledger
    }  

    async init() {  
        console.log("⚡ INITIALIZING ALL-SIZE UNBLINDED STRUCTURAL MATRIX...");  
        
        // STRATEGY 7: Multi-Provider Hydration and Failover Initialization
        for (const url of CONFIG.rpcUrls) {
            this.providers.push(new ethers.JsonRpcProvider(url));
        }
        
        try {  
            this.wsProvider = new ethers.WebSocketProvider(CONFIG.wsUrl);  
            await this.wsProvider.getNetwork();   
            console.log("🚀 STREAMING RAW BLOCK HEADS VIA WEBSOCKET");  
        } catch (err) {  
            console.log("⚠️ WS Primary Unavailable. Operating strictly on Fallback RPC Array...");  
            this.wsProvider = null;
        }  
        
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.getProvider());  
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.wallet);  
    }  

    getProvider() {
        return this.providers[this.activeProviderIndex];
    }

    handleRpcFailover() {
        this.activeProviderIndex = (this.activeProviderIndex + 1) % this.providers.length;
        console.log(`🔄 [FAILOVER] Shifting execution engine to Provider Endpoint #${this.activeProviderIndex}`);
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.getProvider());  
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.wallet); 
    }

    generateMultiHopRoutes() {  
        const routes = [];  

        for (let i = 0; i < ROUTERS.length; i++) {  
            for (let j = 0; j < ROUTERS.length; j++) {  
                if (i === j) continue;  
                for (const name of TOKEN_NAMES) {  
                    // Standard Paths
                    routes.push({  
                        name: `2-Hop [${name}] via ${DEX_NAMES[i]}→${DEX_NAMES[j]}`,  
                        buyRouter: ROUTERS[i],  
                        sellRouter: ROUTERS[j],  
                        pathToToken: [TOKENS.USDC, TOKENS[name]],  
                        pathToUSDC: [TOKENS[name], TOKENS.USDC]  
                    });  

                    // STRATEGY 1: Bridge Asset Route Injection Array Matrix
                    for (const bridge of BRIDGES) {
                        if (TOKENS[name] === bridge) continue;
                        routes.push({
                            name: `Bridge [${name}➔${Object.keys(TOKENS).find(k => TOKENS[k] === bridge)}] via ${DEX_NAMES[i]}→${DEX_NAMES[j]}`,
                            buyRouter: ROUTERS[i],
                            sellRouter: ROUTERS[j],
                            pathToToken: [TOKENS.USDC, bridge, TOKENS[name]],
                            pathToUSDC: [TOKENS[name], bridge, TOKENS.USDC]
                        });
                    }
                }  
            }  
        }  
        return routes;  
    }  

    // STRATEGY 3 & 8 & 9: Complete Gas-Aware Multi-Stage Matrix Logging Layout
    logBreakdownMetrics(routeName, size, grossOut, gasCostUSDC, flashFeeUSDC, slippageUSDC, netProfitUSDC) {
        const sizeFormatted = Number(ethers.formatUnits(size, 6)).toFixed(2);
        const netFormatted = Number(ethers.formatUnits(netProfitUSDC, 6)).toFixed(6);
        
        if (netProfitUSDC > 0n) {
            console.log(`🟢 [PROFIT FOUND] — ${routeName} | Size: ${sizeFormatted}`);
            console.log(`   Gross:    +${Number(ethers.formatUnits(grossOut, 6)).toFixed(6)} USDC`);
            console.log(`   Gas:      -${Number(ethers.formatUnits(gasCostUSDC, 6)).toFixed(6)} USDC`);
            console.log(`   Flash:    -${Number(ethers.formatUnits(flashFeeUSDC, 6)).toFixed(6)} USDC`);
            console.log(`   Slip:     -${Number(ethers.formatUnits(slippageUSDC, 6)).toFixed(6)} USDC`);
            console.log(`   --------------------------`);
            console.log(`   Net:      +${netFormatted} USDC\n`);
        } else {
            console.log(`默默 [LOSS] ${routeName.padEnd(50)} | Size: ${sizeFormatted.padStart(9)} | Net: ${netFormatted} USDC`);
        }
    }

    async scanAndExecute(blockNumber) {  
        const routes = this.generateMultiHopRoutes();  
        this.quoteCache.clear(); // Clear memory buffer keys on every block tick boundary
        
        // STRATEGY 2: Adaptive Refinement Layer Matrices
        let candidates = [  
            ethers.parseUnits("0.10", 6),  
            ethers.parseUnits("1.00", 6),  
            ethers.parseUnits("10.00", 6),  
            ethers.parseUnits("100.00", 6),  
            ethers.parseUnits("500.00", 6),  
            ethers.parseUnits("1000.00", 6),  
            ethers.parseUnits("5000.00", 6),  
            ethers.parseUnits("10000.00", 6),  
            ethers.parseUnits("25000.00", 6),  
            ethers.parseUnits("50000.00", 6)  
        ];  

        const baseFeeData = await this.getProvider().getFeeData();
        const currentGasPrice = baseFeeData.gasPrice || ethers.parseUnits("100", "gwei");

        // STRATEGY 5: Parallel Pipeline Batching Splice Array
        const BATCH_SIZE = 12;  
        for (let i = 0; i < routes.length; i += BATCH_SIZE) {  
            if (this.currentBlockNumber > blockNumber) break; 
              
            const batch = routes.slice(i, i + BATCH_SIZE);  
            
            // Execute simulations concurrently
            await Promise.all(batch.map(async (route) => {  
                let activeSizes = [...candidates];
                let bestSizeForRoute = null;
                let maxObservedNetProfit = -10000000000n;

                // Step 1: Scan Candidate Space Iteratively
                for (const size of activeSizes) {
                    // STRATEGY 6: Cache Key Lookup Logic Execution
                    const cacheKey = `${route.buyRouter}-${route.sellRouter}-${size.toString()}-${route.pathToToken.join("-")}`;
                    let result;

                    if (this.quoteCache.has(cacheKey)) {
                        result = this.quoteCache.get(cacheKey);
                    } else {
                        try {
                            result = await this.contract.simulateArbitrageProfit(  
                                route.buyRouter,  
                                route.sellRouter,  
                                size, 
                                route.pathToToken,  
                                route.pathToUSDC  
                            );  
                            this.quoteCache.set(cacheKey, result);
                        } catch (err) {
                            if (err.message.includes("bounds") || err.message.includes("code=SERVER_ERROR")) {
                                this.handleRpcFailover();
                            }
                            continue; 
                        }
                    }

                    // STRATEGY 3 & 9: Gas-Aware Fee Allocation Processing Engine
                    const nativeGasCostWei = CONFIG.gasLimit * currentGasPrice;
                    const gasCostUSDC = (nativeGasCostWei * BigInt(Math.floor(CONFIG.polPriceUSDC * 1000))) / (1000n * 10n**12n);
                    
                    // Aave V3 Flash Loan Premium structural deduction ($amount * 0.05%)
                    const flashFeeUSDC = (size * 5n) / 10000n; 
                    
                    // STRATEGY 4 & 10: Size-Dependent Dynamic Slippage Reserve Allocation Calculation
                    const slipBasisPoints = size > ethers.parseUnits("10000", 6) ? 50n : 20n; // 0.5% vs 0.2%
                    const slippageReserve = (size * slipBasisPoints) / 10000n;

                    const grossProfit = result.estimatedProfit;
                    const netProfit = grossProfit - gasCostUSDC - flashFeeUSDC - slippageReserve;

                    if (netProfit > maxObservedNetProfit) {
                        maxObservedNetProfit = netProfit;
                        if (netProfit > 0n) bestSizeForRoute = size;
                    }

                    this.logBreakdownMetrics(route.name, size, grossProfit, gasCostUSDC, flashFeeUSDC, slippageReserve, netProfit);
                }

                // STRATEGY 2: Local Search Precision Adjustment Step Loop
                if (bestSizeForRoute && bestSizeForRoute === ethers.parseUnits("5000", 6)) {
                    const localRefinementSizes = [
                        ethers.parseUnits("4000", 6),
                        ethers.parseUnits("4500", 6),
                        ethers.parseUnits("5500", 6),
                        ethers.parseUnits("6000", 6)
                    ];
                    
                    for (const size of localRefinementSizes) {
                        try {
                            const result = await this.contract.simulateArbitrageProfit(route.buyRouter, route.sellRouter, size, route.pathToToken, route.pathToUSDC);
                            const nativeGasCostWei = CONFIG.gasLimit * currentGasPrice;
                            const gasCostUSDC = (nativeGasCostWei * BigInt(Math.floor(CONFIG.polPriceUSDC * 1000))) / (1000n * 10n**12n);
                            const flashFeeUSDC = (size * 5n) / 10000n;
                            const slipBasisPoints = size > ethers.parseUnits("10000", 6) ? 50n : 20n;
                            const slippageReserve = (size * slipBasisPoints) / 10000n;
                            
                            const netProfit = result.estimatedProfit - gasCostUSDC - flashFeeUSDC - slippageReserve;
                            
                            if (netProfit > maxObservedNetProfit) {
                                maxObservedNetProfit = netProfit;
                                bestSizeForRoute = size;
                            }
                            this.logBreakdownMetrics(route.name, size, result.estimatedProfit, gasCostUSDC, flashFeeUSDC, slippageReserve, netProfit);
                        } catch (e) {}
                    }
                }

                // STRATEGY 9: Execution Trigger Gated Final Net Evaluation Block
                if (maxObservedNetProfit >= CONFIG.minimumNetProfitUSDC && bestSizeForRoute) {
                    await this.triggerExecution(route, bestSizeForRoute);
                }
            }));  
        }  
    }  

    async triggerExecution(route, amountIn) {  
        if (this.pendingTxs.size >= CONFIG.maxPendingTxs) return;  
        const deadline = Math.floor(Date.now() / 1000) + 60;  
        const txKey = `${route.name}-${amountIn.toString()}`;  

        if (this.pendingTxs.has(txKey)) return;  
        this.pendingTxs.set(txKey, Date.now());  

        try {  
            console.log(`\n🚀 MET BREAKDOWN REQUIREMENT — DISPATCHING TARGET MATRIX ATOMIC EXECUTION: ${route.name}`);  
            const tx = await this.contract.executeBestFlashLoanArbitrage(  
                route.buyRouter,  
                route.sellRouter,  
                [amountIn],  
                route.pathToToken,  
                route.pathToUSDC,  
                deadline,  
                {  
                    gasLimit: CONFIG.gasLimit,  
                    maxPriorityFeePerGas: CONFIG.priorityFee,  
                    maxFeePerGas: CONFIG.priorityFee * 2n + (await this.getProvider().getFeeData()).gasPrice,  
                }  
            );  
            console.log(`   ⚡ Dispatch Complete! Hash: ${tx.hash}`);  
            await tx.wait();  
            console.log(`   ✅ Target Block Settlement Complete.\n`);  
        } catch (e) {  
            console.log(`   ❌ Deficit Protection Engine: On-chain simulation protected core balances.\n`);  
        } finally {  
            this.pendingTxs.delete(txKey);  
        }  
    }  

    async start() {  
        await this.init();  
        if (this.wsProvider) {
            this.wsProvider.on("block", (blockNumber) => {  
                this.currentBlockNumber = blockNumber;  
                console.log(`\n📦 Block #${blockNumber} — [CONCURRENT DYNAMIC VECTOR SCAN]`);  
                this.scanAndExecute(blockNumber);  
            });  
        } else {
            // Fallback interval polling method if WebSocket layer breaks
            setInterval(async () => {
                const blockNumber = await this.getProvider().getBlockNumber();
                if (blockNumber > this.currentBlockNumber) {
                    this.currentBlockNumber = blockNumber;
                    console.log(`\n📦 Block #${blockNumber} — [POLLING DYNAMIC VECTOR SCAN]`);
                    this.scanAndExecute(blockNumber);
                }
            }, 1000);
        }
    }  
}  

const bot = new RealTimeArbitrageBot();  
bot.start();
