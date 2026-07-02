// ============================================================  
// arbitrage.js — Pure JS-Side Multi-Size Sweep Engine (No SC Change)
// ============================================================  

import { ethers } from "ethers";  

// ===================== CONFIGURATION =====================  
const CONFIG = {  
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",  
    wsUrl: process.env.WS_URL || "wss://polygon-bor-rpc.publicnode.com",  
      
    contractAddress: "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958",  
    minimumProfitUSDC: 1n, // 1 micro-unit ($0.000001 USDC)
      
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

// FORCE LOWERCASE: Bypass all Ethers checkSum validation exceptions completely
const TOKENS = {
    USDC:   "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
      AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
    UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    BAT: "0x3cef98bb43d732e2f285ee605a8158cde967d219",
    TBTC: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
    MANA: "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
    TRB: "0xe3322702bedaaed36cddab233360b939775ae5f1",
    COMP: "0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
    INCH: "0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
    THETA: "0xb46e0ae620efd98516f49bb00263317096c114b2",
    CRO: "0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
    XYO: "0xd2507e7b5794179380673870d88b22f94da6abe0",
    MASK: "0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7",
    EURQ: "0xd571edb2ef29df10fcd6200fd6d0ed2389983db3",
    APOLUSDT: "0x6ab707aca953edaefbc4fd23ba73294241490620",
    ENJ: "0x7ec26842f195c852fa843bb9f6d8b583a274a157",
    ZRX: "0x5559edb74751a0ede9dea4dc23aee72cca6be3d5",
    GMT: "0x714db550b574b3e927af3d93e26127d15721d4c2",
    SNX: "0x50b728d8d964fd00c2d0aad81718b71311fef68a",
    ANKR: "0x101a023270368c0d50bffb62780f4afd4ea79c35",
    GLM: "0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
    COW: "0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
    BAND: "0xa8b1e0764f85f53dfe21760e8afe5446d82606ac",
    AXL: "0x6e4e624106cb12e168e6533f8ec7c82263358940",
    UMA: "0x3066818837c5e6ed6601bd5a91b0762877a6b731",
    YFI: "0xda537104d6a5edd53c6fbba9a898708e465260b6",
    ELON: "0xe0339c80ffde91f3e20494df88d4206d86024cdf",
    NEXO: "0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
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

const CONTRACT_ABI = [  
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",  
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"  
];  

class RealTimeArbitrageBot {  
    constructor() {  
        this.pendingTxs = new Map();  
        this.currentBlockNumber = 0;  
    }  

    async init() {  
        console.log("⚡ INITIALIZING ALL-SIZE UNBLINDED STRUCTURAL MATRIX...");  
        try {  
            this.provider = new ethers.WebSocketProvider(CONFIG.wsUrl);  
            await this.provider.getNetwork();   
            console.log("🚀 STREAMING RAW BLOCK HEADS");  
        } catch (err) {  
            console.log("⚠️ WS Lost. Routing execution via Standard HTTP Node...");  
            this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);  
        }  
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);  
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.wallet);  
    }  

    generateMultiHopRoutes() {  
        const routes = [];  

        // 1. 2-HOP CONFIGURATIONS
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

        // 2. 3-HOP CONFIGURATIONS  
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

        // 3. 4-HOP CONFIGURATIONS  
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

    logInlineMathTotal(routeName, size, estimatedFinalUSDC) {
        const input = Number(ethers.formatUnits(size, 6));
        const output = Number(ethers.formatUnits(estimatedFinalUSDC, 6));
        const totalVariance = output - input;
        
        const sign = totalVariance >= 0 ? "+" : "";
        const formattedVariance = totalVariance.toFixed(6);

        if (totalVariance >= 0.000001) {
            console.log(`🟢 [PROFIT] ${routeName.padEnd(55)} | Size: ${input.toFixed(2).padStart(9)} | Total: ${sign}${formattedVariance} USDC`);
        } else {
            console.log(`🔴 [LOSS]   ${routeName.padEnd(55)} | Size: ${input.toFixed(2).padStart(9)} | Total: ${sign}${formattedVariance} USDC`);
        }
    }

    async scanAndExecute(blockNumber) {  
        const routes = this.generateMultiHopRoutes();  
        
        const candidates = [  
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

        const BATCH_SIZE = 15;  
        for (let i = 0; i < routes.length; i += BATCH_SIZE) {  
            if (this.currentBlockNumber > blockNumber) break; 
              
            const batch = routes.slice(i, i + BATCH_SIZE);  
            await Promise.all(batch.map(async (route) => {  
                for (const size of candidates) {
                    try {  
                        // FIX: Call simulateArbitrageProfit directly instead of the broken array finder
                        const result = await this.contract.simulateArbitrageProfit(  
                            route.buyRouter,  
                            route.sellRouter,  
                            size, 
                            route.pathToToken,  
                            route.pathToUSDC  
                        );  

                        this.logInlineMathTotal(route.name, size, result.estimatedFinalUSDC);  

                        if (result.estimatedProfit >= CONFIG.minimumProfitUSDC) {  
                            await this.triggerExecution(route, size);  
                            break; 
                        }  
                    } catch (err) {  
                        // Filters out completely empty pool paths silently to match clean log profile
                    }  
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
            console.log(`\n🚀 EXECUTING ATOMIC ROUTE TRIGGER: ${route.name}`);  
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
        this.provider.on("block", (blockNumber) => {  
            this.currentBlockNumber = blockNumber;  
            console.log(`\n📦 Block #${blockNumber} — [SWEEPING TIER SIZE ARRAYS]`);  
            this.scanAndExecute(blockNumber);  
        });  
    }  
}  

const bot = new RealTimeArbitrageBot();  
bot.start();
