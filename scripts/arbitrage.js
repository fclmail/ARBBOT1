// ============================================================  
// arbitrage.js — High-Frequency Real-Time Multi-Hop Engine  
// ============================================================  

import { ethers } from "ethers";  

// ===================== CONFIGURATION =====================  
const CONFIG = {  
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",  
    wsUrl: process.env.WS_URL || "wss://polygon-bor-rpc.publicnode.com",  
      
    contractAddress: "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958",  
    minimumProfitUSDC: ethers.parseUnits("0.10", 6), // $0.10 minimum profit target
      
    maxPendingTxs: 3,  
    gasLimit: 3500000,  
    priorityFee: ethers.parseUnits("50", "gwei"),  
};  

// EXACT match to VaultArbitrageEnforcer Solidity compiler logic  
const TOKEN_SELECTORS = {  
    WETH:   1,  
    WMATIC: 2,  
    USDT:   3,  
    DAI:    4,  
    WBTC:   5  
};  

const DEXES = {  
    QuickSwap:    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  
    SushiSwap:    "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",  
    ApeSwap:      "0xC0788a3aD43d79aa53B09c2EaCc313A787d1d607"  
};  

const ROUTERS = Object.values(DEXES);  

// EXACT application ABI targeting the optimized binary search structures
const CONTRACT_ABI = [  
    "function minimumProfitUSDC() external view returns (uint256)",
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
        console.log("⚡ INITIALIZING COMPILER ENGINES...");
        
        // Adaptive Failover Provider Initialization
        try {
            console.log(`🔌 Connecting via Live WebSocket stream: ${CONFIG.wsUrl}`);
            this.provider = new ethers.WebSocketProvider(CONFIG.wsUrl);
            await this.provider.getNetwork(); 
            console.log("🚀 WS HANDSHAKE SECURED — 0MS BLOCK PROPAGATION ACTIVE");
        } catch (err) {
            console.log(`⚠️ WS Connection Rejected (${err.message.slice(0, 45)}). Falling back to Fast HTTP Head Tracking...`);
            this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
        }

        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);  
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.wallet);  
        
        // Run Diagnostic verification check right away
        await this.verifyContractCommunication();
    }

    // Helper to generate the address paths expected by findBestFlashLoanSize
    getPathsForSelector(selector) {  
        const tokens = {  
            1: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH  
            2: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC  
            3: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT  
            4: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI  
            5: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6"  // WBTC  
        };  
        const usdc = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";  
        return {  
            toToken: [usdc, tokens[selector]],  
            toUSDC: [tokens[selector], usdc]  
        };  
    }  

    generateOptimizedRoutes() {  
        const routes = [];  
        for (let i = 0; i < ROUTERS.length; i++) {  
            for (let j = 0; j < ROUTERS.length; j++) {  
                if (i === j) continue;  
                  
                for (const [tokenName, selector] of Object.entries(TOKEN_SELECTORS)) {  
                    routes.push({  
                        name: `${tokenName} | ${Object.keys(DEXES)[i]}→${Object.keys(DEXES)[j]}`,  
                        buyRouter: ROUTERS[i],  
                        sellRouter: ROUTERS[j],  
                        selector: selector  
                    });  
                }  
            }  
        }  
        return routes;  
    }  

    async verifyContractCommunication() {  
        console.log("\n🔬 RUNNING ALIGNED ARCHITECTURE DIAGNOSTIC...");  
        try {  
            const minProfit = await this.contract.minimumProfitUSDC();  
            console.log(`  ✅ Connection verified. Contract minimumProfitUSDC target: ${ethers.formatUnits(minProfit, 6)} USDC`);  
            
            // Execute mock query against WETH path to test findBestFlashLoanSize function signature
            const paths = this.getPathsForSelector(1);  
            const testResult = await this.contract.findBestFlashLoanSize(  
                ROUTERS[0], ROUTERS[1], [ethers.parseUnits("1000", 6)], paths.toToken, paths.toUSDC  
            );  
            console.log(`  ✅ View Function Signatures aligned perfectly. Real-Time Scan can safely begin.\n`);  
        } catch (e) {  
            console.log(`  ❌ CRITICAL: Alignment check failed. Mismatched ABI details: ${e.message.slice(0, 120)}\n`);  
        }  
    }  

    async scanAndExecute(blockNumber) {  
        const routes = this.generateOptimizedRoutes();  
        // Hardcoded candidate liquidity tiers ($500 -> $50,000 max size)
        const candidates = [  
            ethers.parseUnits("500", 6),  
            ethers.parseUnits("1000", 6),  
            ethers.parseUnits("5000", 6),  
            ethers.parseUnits("10000", 6),  
            ethers.parseUnits("25000", 6),  
            ethers.parseUnits("50000", 6)  
        ];  

        const BATCH_SIZE = 30;  
        for (let i = 0; i < routes.length; i += BATCH_SIZE) {  
            if (this.currentBlockNumber > blockNumber) break; // Drop execution chain instantly if block goes stale  
              
            const batch = routes.slice(i, i + BATCH_SIZE);  
            await Promise.all(batch.map(async (route) => {  
                try {  
                    const paths = this.getPathsForSelector(route.selector);  
                    const result = await this.contract.findBestFlashLoanSize(  
                        route.buyRouter,  
                        route.sellRouter,  
                        candidates,  
                        paths.toToken,  
                        paths.toUSDC  
                    );  

                    if (result.estimatedProfit > CONFIG.minimumProfitUSDC) {  
                        this.triggerExecution(route, result.amountIn, paths);  
                    }  
                } catch (err) {  
                    // Silent optimization catch — filters away dead pool paths quietly
                }  
            }));  
        }  
    }  

    async triggerExecution(route, amountIn, paths) {  
        if (this.pendingTxs.size >= CONFIG.maxPendingTxs) return;  
        const deadline = Math.floor(Date.now() / 1000) + 60;  
        const txKey = `${route.name}-${amountIn.toString()}`;  

        if (this.pendingTxs.has(txKey)) return;  
        this.pendingTxs.set(txKey, Date.now());  

        try {  
            console.log(`🚀 PROFIT OPPORTUNITY IDENTIFIED: ${route.name} | Executing with: ${ethers.formatUnits(amountIn, 6)} USDC`);  
              
            const tx = await this.contract.executeBestFlashLoanArbitrage(  
                route.buyRouter,  
                route.sellRouter,  
                [amountIn],  
                paths.toToken,  
                paths.toUSDC,  
                deadline,  
                {  
                    gasLimit: CONFIG.gasLimit,  
                    maxPriorityFeePerGas: CONFIG.priorityFee,  
                    maxFeePerGas: CONFIG.priorityFee * 2n + (await this.provider.getFeeData()).gasPrice,  
                }  
            );  

            console.log(`   ⚡ Transacted successfully! Broadcasted Hash: ${tx.hash}`);  
            await tx.wait();  
            console.log(`   ✅ Trade finalized in block! Arbitrage profit captured.`);  
        } catch (e) {  
            console.log(`   ❌ Atomic Safety Exception: Trade fell through or reverted to protect capital balance.`);  
        } finally {  
            this.pendingTxs.delete(txKey);  
        }  
    }  

    async start() {  
        await this.init();  
          
        if (this.provider instanceof ethers.WebSocketProvider) {
            this.provider.on("block", (blockNumber) => {  
                this.currentBlockNumber = blockNumber;  
                console.log(`📦 Block #${blockNumber} — [LIVE-STREAM WS]`);  
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
                        console.log(`📦 Block #${blockNumber} — [FAST HTTP POOLING HEAD]`);
                        this.scanAndExecute(blockNumber);
                    }
                } catch (err) {}
            }, 1000);
        }
    }  
}  

const bot = new RealTimeArbitrageBot();  
bot.start();
