// ============================================================  
// arbitrage.js — Completely Unblinded Real-Time Math Engine
// ============================================================  

import { ethers } from "ethers";  

// ===================== CONFIGURATION =====================  
const CONFIG = {  
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",  
    wsUrl: process.env.WS_URL || "wss://polygon-bor-rpc.publicnode.com",  
      
    contractAddress: "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958",  
    // 1 micro-unit = 0.000001 USDC
    minimumProfitUSDC: 1n, 
      
    maxPendingTxs: 3,  
    gasLimit: 4000000, 
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
        console.log("⚡ INITIALIZING COMPLETELY UNBLINDED MULTI-HOP ENGINE...");  
        try {  
            this.provider = new ethers.WebSocketProvider(CONFIG.wsUrl);  
            await this.provider.getNetwork();   
            console.log("🚀 WS PIPELINE ACTIVE — STREAMING BLOCKS WITH FULL VERBOSE REPORTING");  
        } catch (err) {  
            console.log("⚠️ WS Failure. Falling back to HTTP...");  
            this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);  
        }  
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);  
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.wallet);  
    }  

    generateMultiHopRoutes() {  
        const routes = [];  

        // 1. 2-HOP COMBINATIONS
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

        // 2. 3-HOP COMBINATIONS  
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

        // 3. 4-HOP COMBINATIONS  
        for (let i = 0; i < ROUTERS.length; i++) {  
            for (let j = 0; j < ROUTERS.length; j++) {  
                if (i === j) continue;  
                const executionTokens = ["WETH", "WMATIC", "USDT"];
                for (const t1 of executionTokens) {  
                    for (const t2 of executionTokens) {  
                        for (const t3 of executionTokens) {  
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

    // Unblinded inline output tracking matrix
    logInlineMathTotal(routeName, amountIn, estimatedFinalUSDC) {
        const input = Number(ethers.formatUnits(amountIn, 6));
        const output = Number(ethers.formatUnits(estimatedFinalUSDC, 6));
        const totalVariance = output - input;
        
        const sign = totalVariance >= 0 ? "+" : "";
        const formattedVariance = totalVariance.toFixed(6);

        // Highlight positive routes clearly to separate from negative noise
        if (totalVariance >= 0.000001) {
            console.log(`🟢 [PROFIT] ${routeName.padEnd(55)} | Size: ${input.toString().padStart(6)} | Total: ${sign}${formattedVariance} USDC`);
        } else {
            console.log(`🔴 [LOSS]   ${routeName.padEnd(55)} | Size: ${input.toString().padStart(6)} | Total: ${sign}${formattedVariance} USDC`);
        }
    }

    async scanAndExecute(blockNumber) {  
        const routes = this.generateMultiHopRoutes();  
        // Evaluating across your target liquidity size thresholds
        const candidates = [  
            ethers.parseUnits("1000", 6),  
            ethers.parseUnits("10000", 6)  
        ];  

        const BATCH_SIZE = 25;  
        for (let i = 0; i < routes.length; i += BATCH_SIZE) {  
            if (this.currentBlockNumber > blockNumber) {
                console.log(`⚠️ Chain dropped remaining batch sequences: New block head preempted current processing window.`);
                break; 
            }
              
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

                    // UNBLIND: Every processed path reports metrics instantly
                    this.logInlineMathTotal(route.name, result.amountIn, result.estimatedFinalUSDC);

                    if (result.estimatedProfit >= CONFIG.minimumProfitUSDC) {  
                        this.triggerExecution(route, result.amountIn);  
                    }  
                } catch (err) {  
                    // If an EVM query breaks (e.g. pool lacks deep liquidity reserves), flag it visibly
                    console.log(`💀 [REVERT] ${route.name.padEnd(55)} | Engine message: ${err.message.slice(0, 30)}`);
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
            console.log(`🚀 EXECUTING ATOMIC TRANSACTION: ${route.name}`);  
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
            console.log(`   ⚡ Transaction Dispatched! Hash: ${tx.hash}`);  
            await tx.wait();  
            console.log(`   ✅ Confirmed! Balance successfully updated.`);  
        } catch (e) {  
            console.log(`   ❌ On-Chain Safety Triggered: Memory sandbox transaction protected from deficit.`);  
        } finally {  
            this.pendingTxs.delete(txKey);  
        }  
    }  

    async start() {  
        await this.init();  
        this.provider.on("block", (blockNumber) => {  
            this.currentBlockNumber = blockNumber;  
            console.log(`\n📦 Block #${blockNumber} — [UNBLINDED MULTI-HOP MONITORING INITIALIZED]`);  
            this.scanAndExecute(blockNumber);  
        });  
    }  
}  

const bot = new RealTimeArbitrageBot();  
bot.start();
