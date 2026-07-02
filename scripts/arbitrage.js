// ============================================================  
// arbitrage.js — Multi-Hop Real-Time Routing Engine (2, 3, & 4 Hops)
// ============================================================  

import { ethers } from "ethers";  

// ===================== CONFIGURATION =====================  
const CONFIG = {  
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",  
    wsUrl: process.env.WS_URL || "wss://polygon-bor-rpc.publicnode.com",  
      
    contractAddress: "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958",  
    // 1 micro-unit = 0.000001 USDC (Matches contract state)
    minimumProfitUSDC: 1n, 
      
    maxPendingTxs: 3,  
    gasLimit: 4000000, // Slightly bumped to handle 4-hop EVM simulation overhead
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
    USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    WETH:   "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI:    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    WBTC:   "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6"
};

const DEXES = {  
    QuickSwap:    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  
    SushiSwap:    "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",  
    ApeSwap:      "0xC0788a3aD43d79aa53B09c2EaCc313A787d1d607"  
};  

const ROUTERS = Object.values(DEXES);  
const DEX_NAMES = Object.keys(DEXES);
const TOKEN_NAMES = Object.keys(TOKEN_SELECTORS);

const CONTRACT_ABI = [  
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] memory candidateSizes, address[] memory pathToToken, address[] memory pathToUSDC) public view returns (tuple(uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit) best)",  
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",  
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"  
];  

class RealTimeArbitrageBot {  
    constructor() {  
        this.pendingTxs = new Map();  
        this.currentBlockNumber = 0;  
    }  

    async init() {  
        console.log("⚡ INITIALIZING MULTI-HOP ENGINE...");  
        try {  
            this.provider = new ethers.WebSocketProvider(CONFIG.wsUrl);  
            await this.provider.getNetwork();   
            console.log("🚀 WS PIPELINE ACTIVE — STREAMING BLOCKS");  
        } catch (err) {  
            console.log("⚠️ WS Failure. Falling back to HTTP JSON-RPC Head tracking...");  
            this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);  
        }  
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);  
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.wallet);  
    }  

    // Dynamic generation of multi-hop paths to trick standard 2-hop view interfaces
    generateMultiHopRoutes() {  
        const routes = [];  

        // 1. STANDARD 2-HOP ROUTES (USDC -> Token -> USDC)
        for (let i = 0; i < ROUTERS.length; i++) {  
            for (let j = 0; j < ROUTERS.length; j++) {  
                if (i === j) continue;  
                for (const name of TOKEN_NAMES) {  
                    routes.push({  
                        name: `2-Hop [${name}] via ${DEX_NAMES[i]}→${DEX_NAMES[j]}`,  
                        buyRouter: ROUTERS[i],  
                        sellRouter: ROUTERS[j],  
                        pathToToken: [TOKENS.USDC, TOKENS[name]],  
                        pathToUSDC: [TOKENS[name], TOKENS.USDC]  
                    });  
                }  
            }  
        }  

        // 2. 3-HOP COMBINATORIAL ROUTES (USDC -> TokenA -> TokenB -> USDC)
        for (let i = 0; i < ROUTERS.length; i++) {  
            for (let j = 0; j < ROUTERS.length; j++) {  
                if (i === j) continue;  
                for (const t1 of TOKEN_NAMES) {  
                    for (const t2 of TOKEN_NAMES) {  
                        if (t1 === t2) continue;  
                        routes.push({  
                            name: `3-Hop [${t1}→${t2}] via ${DEX_NAMES[i]}→${DEX_NAMES[j]}`,  
                            buyRouter: ROUTERS[i],  
                            sellRouter: ROUTERS[j],  
                            pathToToken: [TOKENS.USDC, TOKENS[t1], TOKENS[t2]],  
                            pathToUSDC: [TOKENS[t2], TOKENS.USDC]  
                        });  
                    }  
                }  
            }  
        }  

        // 3. 4-HOP COMBINATORIAL ROUTES (USDC -> TokenA -> TokenB -> TokenC -> USDC)
        for (let i = 0; i < ROUTERS.length; i++) {  
            for (let j = 0; j < ROUTERS.length; j++) {  
                if (i === j) continue;  
                // Scanning top 3 pairs to protect execution gas memory pools
                const limitedTokens = ["WETH", "WMATIC", "USDT"];
                for (const t1 of limitedTokens) {  
                    for (const t2 of limitedTokens) {  
                        for (const t3 of limitedTokens) {  
                            if (t1 === t2 || t2 === t3) continue;  
                            routes.push({  
                                name: `4-Hop [${t1}→${t2}→${t3}] via ${DEX_NAMES[i]}→${DEX_NAMES[j]}`,  
                                buyRouter: ROUTERS[i],  
                                sellRouter: ROUTERS[j],  
                                pathToToken: [TOKENS.USDC, TOKENS[t1], TOKENS[t2], TOKENS[t3]],  
                                pathToUSDC: [TOKENS[t3], TOKENS.USDC]  
                            });  
                        }  
                    }  
                }  
            }  
        }  
        return routes;  
    }  

    async scanAndExecute(blockNumber) {  
        const routes = this.generateMultiHopRoutes();  
        const candidates = [  
            ethers.parseUnits("500", 6),  
            ethers.parseUnits("1000", 6),  
            ethers.parseUnits("5000", 6),  
            ethers.parseUnits("10000", 6),  
            ethers.parseUnits("25000", 6),  
            ethers.parseUnits("50000", 6)  
        ];  

        const BATCH_SIZE = 35;  
        for (let i = 0; i < routes.length; i += BATCH_SIZE) {  
            if (this.currentBlockNumber > blockNumber) break; // Drop loop immediately if next block arrives
              
            const batch = routes.slice(i, i + BATCH_SIZE);  
            await Promise.all(batch.map(async (route) => {  
                try {  
                    const result = await this.contract.findBestFlashLoanSize(  
                        route.buyRouter,  
                        route.sellRouter,  
                        candidates,  
                        route.pathToToken,  
                        route.pathToUSDC  
                    );  

                    if (result.estimatedProfit >= CONFIG.minimumProfitUSDC) {  
                        this.triggerExecution(route, result.amountIn);  
                    }  
                } catch (err) {  
                    // Filters away pools with invalid routing combinations without breaking execution
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
            console.log(`🚀 TARGET IDENTIFIED: ${route.name} | Size: ${ethers.formatUnits(amountIn, 6)} USDC`);  
              
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
                    maxFeePerGas: CONFIG.priorityFee * 2n + (await this.provider.getFeeData()).gasPrice,  
                }  
            );  

            console.log(`   ⚡ Broadcast Successful! Hash: ${tx.hash}`);  
            await tx.wait();  
            console.log(`   ✅ Transaction Finalized!`);  
        } catch (e) {  
            console.log(`   ❌ EVM Atomicity Triggered: Reverted to protect wallet balances.`);  
        } finally {  
            this.pendingTxs.delete(txKey);  
        }  
    }  

    async start() {  
        await this.init();  
          
        if (this.provider instanceof ethers.WebSocketProvider) {  
            this.provider.on("block", (blockNumber) => {  
                this.currentBlockNumber = blockNumber;  
                console.log(`📦 Block #${blockNumber} — [LIVE MULTI-HOP SCAN]`);  
                this.scanAndExecute(blockNumber);  
            });  
        } else {  
            let lastSeenBlock = 0;  
            setInterval(async () => {  
                try {  
                    const blockNumber = await this.provider.getBlockNumber();  
                    if (blockNumber > lastSeenBlock) {  
                        lastSeenBlock = blockNumber;  
                        this.currentBlockNumber = blockNumber;  
                        console.log(`📦 Block #${blockNumber} — [FAST HTTP SCAN]`);  
                        this.scanAndExecute(blockNumber);  
                    }  
                } catch (err) {}  
            }, 1000);  
        }  
    }  
}  

const bot = new RealTimeArbitrageBot();  
bot.start();
