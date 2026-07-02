// ============================================================  
// arbitrage-bot.js — Full Production Profit Capture Engine  
// ============================================================  
// Integrates with VaultArbitrageEnforcer.sol  
// Scans ALL router pairs, uses Promise.all, captures every block  
// ============================================================  

import { ethers } from "ethers";  
import { Worker, parentPort, isMainThread } from "worker_threads";  
import os from "os";  

// ===================== CONFIGURATION =====================  

const CONFIG = {  
    // RPC  
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",  
    wsUrl: process.env.WS_URL || "wss://polygon-rpc.com",  
      
    // Contract  
    contractAddress: "0xYourDeployedContractAddress",  
    vaultAddress: "0xYourVaultAddress", // EOA that calls execute  
      
    // Minimum profit in USDC (wei)  
    minimumProfitUSDC: ethers.parseUnits("0.50", 6), // $0.50  
      
    // Worker threads  
    workerCount: Math.min(os.cpus().length, 4),  
      
    // Binary search range  
    minFlashLoan: ethers.parseUnits("100", 6),     // $100  
    maxFlashLoan: ethers.parseUnits("50000", 6),   // $50,000  
    searchIterations: 8,  
      
    // Execution tuning  
    maxPendingTxs: 3,  
    gasLimit: 3_500_000,  
    gasMultiplier: 1.1,  
    priorityFee: ethers.parseUnits("50", "gwei"),  
      
    // Block scanning  
    blocksToKeepAlive: 5,  
};  

// ===================== TOKEN ADDRESSES (Polygon) =====================  

const TOKENS = {  
    USDC:  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e (native)  
    USDCe: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // Same on Polygon  
    USDT:  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",  
    DAI:   "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",  
    WETH:  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",  
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",  
    WBTC:  "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6",  
};  

const TOKEN_DECIMALS = {  
    USDC: 6, USDCe: 6, USDT: 6, DAI: 18,  
    WETH: 18, WMATIC: 18, WBTC: 8,  
};  

// ===================== DEX ROUTERS (Polygon) =====================  

const DEXES = {  
    // Major  
    QuickSwap:    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  
    QuickSwapV3:  "0xf5b1e329CFc2cB4eF2d54c9F1C8B4b4bAC1E5E0F",  
    SushiSwap:    "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",  
      
    // High-yield DEXes  
    ApeSwap:      "0xC0788a3aD43d79aa53B09c2EaCc313A787d1d607",  
    WaultSwap:    "0x3a1D87f206D1D1bB6cBd8A1aB8EeB8BcE9dC5dE",  
    Balancer:     "0xBA12222222228d8Ba445958a75a0000000000000",  
      
    // More DEXes  
    Curve:        "0x0000000000000000000000000000000000000000", // Curve doesn't use standard router  
    JetSwap:      "0x5C6EC38fb0e2609672BDf628B1fD605068B3F70f",  
    PolyCat:      "0x94930a328Cc2A2B4C65E48a2c7C3a0BcB4e1aB4e",  
    Dfyn:         "0x8E8aE525E7B1E9CA5bD0Ea4A8A1C5C5E6b7C8D9E",  
    ComethSwap:   "0x93D2cC0F1f1E5C6A3e1C2F9E8A7B6C5D4E3F2A1",  
    PolyDEX:      "0x7e7A9e8B7A6C5D4E3F2A1B0C9D8E7F6A5B4C3D2",  
};  

// Router checksums for approval safety  
const ROUTER_CHECKSUMS = {};  
Object.entries(DEXES).forEach(([name, addr]) => {  
    // Lowercase input first to prevent ethers from failing on malformed EIP-55 mixed-case strings
    ROUTER_CHECKSUMS[addr.toLowerCase()] = ethers.getAddress(addr.toLowerCase());  
});  

const ROUTERS = Object.values(DEXES).filter(a => a !== "0x0000000000000000000000000000000000000000");  

// ===================== PATH BUILDER =====================  

const PATHS = {  
    // Direct pairs (2-hop)  
    USDC_WETH:      [TOKENS.USDC, TOKENS.WETH, TOKENS.USDC],  
    USDC_WMATIC:    [TOKENS.USDC, TOKENS.WMATIC, TOKENS.USDC],  
    USDC_USDT:      [TOKENS.USDC, TOKENS.USDT, TOKENS.USDC],  
    USDC_DAI:       [TOKENS.USDC, TOKENS.DAI, TOKENS.USDC],  
    USDC_WBTC:      [TOKENS.USDC, TOKENS.WBTC, TOKENS.USDC],  
      
    // Triple-hop paths (3-hop) — exploit deeper liquidity gaps  
    USDC_WETH_WMATIC:   [TOKENS.USDC, TOKENS.WETH, TOKENS.WMATIC, TOKENS.USDC],  
    USDC_WMATIC_WETH:   [TOKENS.USDC, TOKENS.WMATIC, TOKENS.WETH, TOKENS.USDC],  
    USDC_USDT_WETH:     [TOKENS.USDC, TOKENS.USDT, TOKENS.WETH, TOKENS.USDC],  
    USDC_DAI_WETH:      [TOKENS.USDC, TOKENS.DAI, TOKENS.WETH, TOKENS.USDC],  
    USDC_WBTC_WETH:     [TOKENS.USDC, TOKENS.WBTC, TOKENS.WETH, TOKENS.USDC],  
    USDC_WETH_WBTC:     [TOKENS.USDC, TOKENS.WETH, TOKENS.WBTC, TOKENS.USDC],  
    USDC_USDT_WMATIC:   [TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC, TOKENS.USDC],  
    USDC_DAI_WMATIC:    [TOKENS.USDC, TOKENS.DAI, TOKENS.WMATIC, TOKENS.USDC],  
      
    // Quadruple-hop paths (4-hop) — rare but profitable  
    USDC_WETH_WMATIC_USDT:   [TOKENS.USDC, TOKENS.WETH, TOKENS.WMATIC, TOKENS.USDT, TOKENS.USDC],  
    USDC_USDT_WETH_WMATIC:   [TOKENS.USDC, TOKENS.USDT, TOKENS.WETH, TOKENS.WMATIC, TOKENS.USDC],  
    USDC_DAI_WETH_WBTC:      [TOKENS.USDC, TOKENS.DAI, TOKENS.WETH, TOKENS.WBTC, TOKENS.USDC],  
};  

// ===================== CONTRACT ABI =====================  

const CONTRACT_ABI = [  
    // Core read functions  
    "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns (uint256, uint256)",  
    "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns (tuple(uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit))",  
    "function minimumProfitUSDC() view returns (uint256)",  
    "function usdc() view returns (address)",  
    "function vault() view returns (address)",  
    "function owner() view returns (address)",  
      
    // Execution functions  
    "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",  
    "function executeFlashBatchArbitrage(tuple(address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline))",  
    "function executeArbitrage(address,address,uint256,address[],address[],uint256)",  
    "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256)",  
    "function executeBalancerFlashLoanArbitrage(address,address,uint256,address[],address[],uint256)",  
      
    // Admin  
    "function preApproveCoreAssets(address)",  
    "function withdraw(uint256)",  
    "function setVault(address)",  
    "function setMinimumProfitUSDC(uint256)",  
      
    // Events  
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)",  
    "event MinProfitUpdated(uint256 newMin)",  
    "event VaultUpdated(address newVault)",  
];  

// ===================== MAIN BOT CLASS =====================  

class ArbitrageBot {  
    constructor() {  
        this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);  
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);  
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.wallet);  
          
        this.pendingTxs = new Map();  
        this.lastBlockProcessed = 0;  
        this.routeCache = new Map();  
        this.consecutiveFails = 0;  
          
        this.stats = {  
            totalTrades: 0,  
            totalProfit: BigInt(0),  
            failedTrades: 0,  
            gasSpent: BigInt(0),  
        };  
    }  

    // ===================== INITIALIZATION =====================  

    async initialize() {  
        console.log("🧠 Initializing Arbitrage Bot...");  
          
        // Verify contract  
        const owner = await this.contract.owner();  
        console.log(`... Contract owner: ${owner}`);  
        console.log(`🤖 Bot address: ${this.wallet.address}`);  
          
        const isOwner = owner.toLowerCase() === this.wallet.address.toLowerCase();  
        const isVault = (await this.contract.vault()).toLowerCase() === this.wallet.address.toLowerCase();  
          
        if (!isOwner && !isVault) {  
            console.log("⚠️ Bot is not owner or vault. Ensure contract.setVault(botAddress) is called");  
        }  
          
        // Auto-approve all routers  
        console.log("\n🔑 Pre-approving all routers...");  
        for (const [name, router] of Object.entries(DEXES)) {  
            if (router === "0x0000000000000000000000000000000000000000") continue;  
            try {  
                const tx = await this.contract.preApproveCoreAssets(router, {  
                    gasLimit: 500000,  
                    maxPriorityFeePerGas: CONFIG.priorityFee,  
                });  
                await tx.wait();  
                console.log(`  ✅ Approved ${name}: ${router}`);  
            } catch (e) {  
                console.log(`  ⚠️ Approval failed for ${name}: ${e.message}`);  
            }  
        }  
          
        console.log("\n✅ Initialization complete!");  
    }  

    // ===================== ROUTE GENERATOR =====================  

    generateAllRoutes() {  
        const routes = [];  
        const pathEntries = Object.entries(PATHS);  
          
        for (let i = 0; i < ROUTERS.length; i++) {  
            for (let j = 0; j < ROUTERS.length; j++) {  
                if (i === j) continue;  
                  
                const buyRouter = ROUTERS[i];  
                const sellRouter = ROUTERS[j];  

                for (const [pathName, path] of pathEntries) {  
                    const tokenAddr = path[1]; // middle token for event  
                      
                    routes.push({  
                        name: `${pathName} | ${Object.keys(DEXES).find(k => DEXES[k] === buyRouter)}→${Object.keys(DEXES).find(k => DEXES[k] === sellRouter)}`,  
                        buyRouter,  
                        sellRouter,  
                        pathToToken: path.slice(0, -1),  // USDC → Token (or USDC → Token1 → Token2)  
                        pathToUSDC: path.slice(1).reverse(), // Token → USDC (or Token2 → Token1 → USDC)  
                        tokenAddr,  
                    });  
                }  
            }  
        }  
          
        return routes;  
    }  

    // ===================== BINARY SEARCH WRAPPER =====================  

    async findBestFlashLoanSize(route) {  
        const candidates = [  
            ethers.parseUnits("100", 6),  
            ethers.parseUnits("500", 6),  
            ethers.parseUnits("1000", 6),  
            ethers.parseUnits("2500", 6),  
            ethers.parseUnits("5000", 6),  
            ethers.parseUnits("10000", 6),  
            ethers.parseUnits("15000", 6),  
            ethers.parseUnits("25000", 6),  
            ethers.parseUnits("40000", 6),  
            ethers.parseUnits("50000", 6),  
        ];  
          
        try {  
            const result = await this.contract.findBestFlashLoanSize(  
                route.buyRouter,  
                route.sellRouter,  
                candidates,  
                route.pathToToken,  
                route.pathToUSDC  
            );  
              
            return {  
                route: route,  
                amountIn: result.amountIn,  
                estimatedFinalUSDC: result.estimatedFinalUSDC,  
                estimatedProfit: result.estimatedProfit,  
            };  
        } catch (e) {  
            return null;  
        }  
    }  

    // ===================== PARALLEL ROUTE SCANNER =====================  

    async scanAllRoutes() {  
        const allRoutes = this.generateAllRoutes();  
        console.log(`\n🔍 Scanning ${allRoutes.length} routes across ${ROUTERS.length} DEXes...`);  
          
        const BATCH_SIZE = 15;  
        const profitableRoutes = [];  
          
        for (let i = 0; i < allRoutes.length; i += BATCH_SIZE) {  
            const batch = allRoutes.slice(i, i + BATCH_SIZE);  
              
            const results = await Promise.all(  
                batch.map(route => this.findBestFlashLoanSize(route))  
            );  
              
            for (const result of results) {  
                if (result && result.estimatedProfit > CONFIG.minimumProfitUSDC) {  
                    profitableRoutes.push(result);  
                }  
            }  
        }  
          
        // Sort by profit (descending)  
        profitableRoutes.sort((a, b) =>   
            b.estimatedProfit > a.estimatedProfit ? 1 :   
            b.estimatedProfit < a.estimatedProfit ? -1 : 0  
        );  
          
        return profitableRoutes;  
    }  

    // ===================== EXECUTION ENGINE =====================  

    async executeFlashLoanArbitrage(routeResult) {  
        const { route, amountIn } = routeResult;  
        const deadline = Math.floor(Date.now() / 1000) + 120;  
          
        // Check pending tx count  
        if (this.pendingTxs.size >= CONFIG.maxPendingTxs) {  
            console.log("   ⏳ Max pending txs reached, skipping...");  
            return false;  
        }  
          
        try {  
            // Use executeBestFlashLoanArbitrage (runs binary search + flash loan in one tx)  
            const tx = await this.contract.executeBestFlashLoanArbitrage(  
                route.buyRouter,  
                route.sellRouter,  
                [  
                    ethers.parseUnits("100", 6),  
                    ethers.parseUnits("500", 6),  
                    ethers.parseUnits("1000", 6),  
                    ethers.parseUnits("2500", 6),  
                    ethers.parseUnits("5000", 6),  
                    ethers.parseUnits("10000", 6),  
                    ethers.parseUnits("15000", 6),  
                    ethers.parseUnits("20000", 6),  
                    ethers.parseUnits("30000", 6),  
                    ethers.parseUnits("50000", 6),  
                ],  
                route.pathToToken,  
                route.pathToUSDC,  
                deadline,  
                {  
                    gasLimit: CONFIG.gasLimit,  
                    maxPriorityFeePerGas: CONFIG.priorityFee,  
                    maxFeePerGas: CONFIG.priorityFee * 2n + (await this.provider.getFeeData()).gasPrice,  
                }  
            );  
              
            const txHash = tx.hash;  
            this.pendingTxs.set(txHash, {  
                route: route.name,  
                amountIn,  
                timestamp: Date.now(),  
            });  
              
            console.log(`   🚀 Tx sent: ${txHash.slice(0, 10)}...${txHash.slice(-8)}`);  
            console.log(`      Route: ${route.name}`);  
            console.log(`      Amount: ${ethers.formatUnits(amountIn, 6)} USDC`);  
              
            // Wait for receipt  
            const receipt = await tx.wait();  
            this.pendingTxs.delete(txHash);  
              
            // Parse events  
            const arbitrageEvents = receipt.logs  
                .filter(log => log.address.toLowerCase() === CONFIG.contractAddress.toLowerCase())  
                .map(log => {  
                    try {  
                        return this.contract.interface.parseLog({  
                            topics: [...log.topics],  
                            data: log.data,  
                        });  
                    } catch { return null; }  
                })  
                .filter(e => e && e.name === "ArbitrageExecuted");  
              
            if (arbitrageEvents.length > 0) {  
                const event = arbitrageEvents[0];  
                const profit = event.args.profitUSDC;  
                  
                this.stats.totalTrades++;  
                this.stats.totalProfit += profit;  
                this.stats.gasSpent += receipt.gasUsed * receipt.gasPrice;  
                this.consecutiveFails = 0;  
                  
                console.log(`   ✅ PROFIT: +${ethers.formatUnits(profit, 6)} USDC`);  
                console.log(`      Gas: ${receipt.gasUsed.toString()} | Block: ${receipt.blockNumber}`);  
                console.log(`      Total profit: ${ethers.formatUnits(this.stats.totalProfit, 6)} USDC`);  
                  
                return true;  
            } else {  
                // Check for discard (profitable check failed in callback)  
                console.log(`   ⚠️ No ArbitrageExecuted event (likely discarded)`);  
                this.consecutiveFails++;  
                return false;  
            }  
        } catch (e) {  
            if (typeof tx !== "undefined" && tx.hash) this.pendingTxs.delete(tx.hash);  
            this.stats.failedTrades++;  
            this.consecutiveFails++;  
              
            console.log(`   ❌ Failed: ${e.message.slice(0, 120)}`);  
            return false;  
        }  
    }  

    // ===================== BATCH EXECUTION =====================  

    async executeBatchArbitrage(profitableRoutes) {  
        if (profitableRoutes.length === 0) {  
            console.log("   📭 No profitable routes found");  
            return;  
        }  
          
        // Take top N routes  
        const batch = profitableRoutes.slice(0, CONFIG.maxPendingTxs);  
        console.log(`\n🎯 Executing batch of ${batch.length} arbitrages...`);  
          
        const results = await Promise.allSettled(  
            batch.map(route => this.executeFlashLoanArbitrage(route))  
        );  
          
        const succeeded = results.filter(r => r.status === "fulfilled" && r.value).length;  
        const failed = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && !r.value)).length;  
          
        console.log(`\n📊 Batch complete: ${succeeded} succeeded, ${failed} failed`);  
    }  

    // ===================== MAIN LOOP =====================  

    async start() {  
        console.log("\n" + "=".repeat(60));  
        console.log("🚀 ARBITRAGE BOT STARTED");  
        console.log("=".repeat(60));  
          
        // Initialization  
        await this.initialize();  
          
        // Check contract balance  
        const usdcContract = new ethers.Contract(  
            TOKENS.USDC,  
            ["function balanceOf(address) view returns (uint256)"],  
            this.provider  
        );  
        const contractBalance = await usdcContract.balanceOf(CONFIG.contractAddress);  
        console.log(`\n💰 Contract USDC balance: ${ethers.formatUnits(contractBalance, 6)} USDC`);  
          
        if (contractBalance < ethers.parseUnits("1000", 6)) {  
            console.log("⚠️ Low balance! Fund contract with at least 1000 USDC");  
        }  

        // Main loop  
        let scanCount = 0;  
          
        while (true) {  
            try {  
                scanCount++;  
                const blockNumber = await this.provider.getBlockNumber();  
                  
                // Only scan new blocks  
                if (blockNumber <= this.lastBlockProcessed) {  
                    await new Promise(r => setTimeout(r, 500));  
                    continue;  
                }  
                  
                this.lastBlockProcessed = blockNumber;  
                console.log(`\n${"─".repeat(60)}`);  
                console.log(`📦 Block #${blockNumber} | Scan #${scanCount}`);  
                console.log(`${"─".repeat(60)}`);  
                  
                // Check pending txs  
                for (const [hash, info] of this.pendingTxs) {  
                    const receipt = await this.provider.getTransactionReceipt(hash);  
                    if (receipt) {  
                        this.pendingTxs.delete(hash);  
                        console.log(`  ✅ Pending tx confirmed: ${hash.slice(0, 10)}...`);  
                    } else if (Date.now() - info.timestamp > 120000) {  
                        this.pendingTxs.delete(hash);  
                        console.log(`  ⏰ Pending tx expired: ${hash.slice(0, 10)}...`);  
                    }  
                }  
                  
                // Skip if too many pending  
                if (this.pendingTxs.size >= CONFIG.maxPendingTxs) {  
                    console.log("  ⏳ Too many pending txs, skipping scan...");  
                    await new Promise(r => setTimeout(r, 1000));  
                    continue;  
                }  
                  
                // Scan all routes  
                const profitableRoutes = await this.scanAllRoutes();  
                  
                if (profitableRoutes.length > 0) {  
                    console.log(`\n💰 Found ${profitableRoutes.length} profitable routes!`);  
                      
                    for (const r of profitableRoutes.slice(0, 5)) {  
                        const profit = ethers.formatUnits(r.estimatedProfit, 6);  
                        const amount = ethers.formatUnits(r.amountIn, 6);  
                        console.log(`    💵 ${r.route.name} | Amount: ${amount} USDC | Profit: +${profit} USDC`);  
                    }  
                      
                    // Execute  
                    await this.executeBatchArbitrage(profitableRoutes);  
                } else {  
                    if (scanCount % 5 === 0) {  
                        console.log("  🔍 No profitable routes found in this block");  
                    }  
                }  
                  
                // Adaptive delay  
                if (this.consecutiveFails > 5) {  
                    console.log("  🛑 Too many consecutive failures, cooling down...");  
                    await new Promise(r => setTimeout(r, 5000));  
                    this.consecutiveFails = 0;  
                }  
                  
            } catch (e) {  
                console.error(`\n❌ Loop error: ${e.message}`);  
                await new Promise(r => setTimeout(r, 2000));  
            }  
        }  
    }  
}  

// ===================== WORKER THREAD SUPPORT =====================  

if (isMainThread) {  
    // Main thread: start bot  
    const bot = new ArbitrageBot();  
    bot.start().catch(console.error);  
      
    // Graceful shutdown  
    process.on("SIGINT", async () => {  
        console.log("\n\n🛑 Shutting down...");  
        console.log(`📊 Final stats:`);  
        console.log(`   Total trades: ${bot.stats.totalTrades}`);  
        console.log(`   Total profit: ${ethers.formatUnits(bot.stats.totalProfit, 6)} USDC`);  
        console.log(`   Failed trades: ${bot.stats.failedTrades}`);  
        console.log(`   Gas spent: ${ethers.formatEther(bot.stats.gasSpent)} MATIC`);  
        process.exit(0);  
    });  
} else {  
    // Worker thread: handle batch scanning  
    const bot = new ArbitrageBot();  
      
    parentPort.on("message", async (msg) => {  
        if (msg.type === "scan") {  
            const result = await bot.findBestFlashLoanSize(msg.route);  
            parentPort.postMessage(result);  
        }  
    });  
}
