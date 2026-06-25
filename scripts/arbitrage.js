import { ethers } from "ethers";
import dotenv from "dotenv";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const FASTLANE_RPC = "https://polygon.fastlane.live/rpc";
// High-performance public read fallback endpoint to balance scanning demands
const PUBLIC_READ_RPC = "https://polygon-rpc.com"; 
const WSS_NODE = "wss://polygon-bor-rpc.publicnode.com";

const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    DFYN:  "0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429",
    WAULT: "0x594c3618E3CF4879524b11901d866E3578637C55"
};

const HOPS = {
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    DAI:    "0x8f3cf6ad23cd3cadbd9735aff958023239c6a063"
};

const ALL_TOKENS = [
    { name: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
    { name: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
    { name: "AAVE", address: "0xd6df932a45c0f255f85745378292cd1651261eaf" },
    { name: "UNI",  address: "0xb33eaad8d922b1083446bc23f610e4de901657fc" },
    { name: "CRV",  address: "0x172370d5cd6322bef592a1a17af1f3a9aef529b3" },
    { name: "GHST", address: "0x385ab54d003429a320478963283614a4bc23160a" },
    { name: "GRT",  address: "0x5fe2b30c797e656c3d416974759469e320f5c8ab" },
    { name: "WOO",  address: "0x1b815d120b3e76ad17f0490bf7e9ff923a1329c8" }
];

const ENFORCER_ABI = [
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns ((uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit) best)",
    "function executeBestFlashLoanArbitrage(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function getBalance(address token) external view returns (uint256)",
    "function withdrawProfits(address token, uint256 amount) external"
];

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const CANDIDATE_SIZES_6_DECIMALS = [
    ethers.parseUnits(".002", 6),
    ethers.parseUnits("0.0500", 6),
    ethers.parseUnits("2000", 6),
    ethers.parseUnits("10000", 6)
];

const MINIMUM_PROFIT_USDC = 0.000001;
let totalProfitsAccumulated = 0;
const failedOpportunities = [];

// HARD BOUND STATIC NETWORK DEFINITION (Forces Ethers v6 to skip chain-ID handshakes)
const staticPolygonNetwork = ethers.Network.from({
    name: "polygon",
    chainId: 137
});

/* ========================================================================
    COORDINATOR (MAIN THREAD)
   ======================================================================== */
if (isMainThread) {
    console.log(`${GREEN}🚀 FASTLANE UNRESTRICTED REAL-TIME MONITORING ONLINE${RESET}`);
    console.log(` Honeycomb Engine Routing directly via EVM state changes [Sharded Configuration]`);
    console.log(`${CYAN}📡 Connected to FastLane Relay: ${FASTLANE_RPC}${RESET}\n`);

    const streamProvider = new ethers.WebSocketProvider(WSS_NODE, staticPolygonNetwork);
    const workerCount = 4;
    const workers = [];

    const chunkSize = Math.ceil(ALL_TOKENS.length / workerCount);
    for (let i = 0; i < workerCount; i++) {
        const tokenChunk = ALL_TOKENS.slice(i * chunkSize, (i + 1) * chunkSize);
        
        const worker = new Worker(__filename, {
            workerData: { id: i + 1, tokens: tokenChunk }
        });

        worker.on("message", (msg) => {
            if (msg.type === "LOG") console.log(msg.data);
            if (msg.type === "PROFIT") {
                totalProfitsAccumulated += msg.amount;
                console.log(`${GREEN}💰 Total Realized Profits Accumulated: ${totalProfitsAccumulated.toFixed(6)} USDC${RESET}`);
            }
        });

        workers.push(worker);
    }

    console.log(`[System] Initialized ${workerCount} Isolated Worker Threads successfully.`);
    console.log(`[System] Distributed ~${chunkSize} tokens and multi-hop paths per thread.\n`);

    // Use standard read node for tracking balances safely without relay interference
    const monitoringProvider = new ethers.JsonRpcProvider(PUBLIC_READ_RPC, staticPolygonNetwork, { staticNetwork: staticPolygonNetwork });
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, monitoringProvider);

    streamProvider.on("block", async (blockNumber) => {
        console.log(`[Block #${blockNumber}] Scanning on-chain pairs across all shards...`);
        
        if (blockNumber % 5 === 0) {
            try {
                const vaultUsdcBalance = await usdcContract.balanceOf(VAULT_CONTRACT_ADDRESS);
                const formattedBalance = ethers.formatUnits(vaultUsdcBalance, 6);
                console.log(`${GREEN}📊 Current Vault Balance Tracker: ${formattedBalance} USDC${RESET}`);
            } catch (error) {
                // Keep background diagnostics quiet
            }
        }
        
        for (const worker of workers) {
            worker.postMessage({ type: "BLOCK", blockNumber });
        }
    });

} else {
    /* ========================================================================
        PARALLEL WORKER THREAD ENGINE
       ======================================================================== */
    const { id, tokens } = workerData;
    
    // Split workflows: view states over clean public RPC, broadcast exclusively over FastLane Relay
    const readProvider = new ethers.JsonRpcProvider(PUBLIC_READ_RPC, staticPolygonNetwork, { staticNetwork: staticPolygonNetwork });
    const relayProvider = new ethers.JsonRpcProvider(FASTLANE_RPC, staticPolygonNetwork, { staticNetwork: staticPolygonNetwork });
    
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, relayProvider);
    
    // Read operations look at public RPC cache
    const vaultContractRead = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, readProvider);
    // Write operations push strictly down FastLane Relay pipe
    const vaultContractWrite = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, readProvider);

    const routerKeys = Object.keys(ROUTERS);
    const pathMatrices = [];

    for (const token of tokens) {
        for (const [hopName, hopAddress] of Object.entries(HOPS)) {
            if (token.address.toLowerCase() === hopAddress.toLowerCase()) continue;
            
            pathMatrices.push({
                identity: `${hopName} -> ${token.name} -> ${hopName}`,
                pathToToken: [USDC_ADDRESS, hopAddress, token.address],
                pathToUSDC: [token.address, hopAddress, USDC_ADDRESS]
            });
        }
    }

    async function retryFailedOpportunities() {
        if (failedOpportunities.length === 0) return;
        const opportunity = failedOpportunities.shift();
        try {
            const txDeadline = Math.floor(Date.now() / 1000) + 30;
            const tx = await vaultContractWrite.executeBestFlashLoanArbitrage(
                opportunity.buyAddr, 
                opportunity.sellAddr, 
                CANDIDATE_SIZES_6_DECIMALS, 
                opportunity.pathToToken, 
                opportunity.pathToUSDC, 
                txDeadline, 
                { gasLimit: 700000n } // Slightly elevated buffer limit
            );
            const receipt = await tx.wait(1);
            if (receipt && receipt.status === 1) {
                parentPort.postMessage({
                    type: "LOG",
                    data: `${GREEN}🎉 [RETRY INCLUSION SUCCESS] Block #${receipt.blockNumber}${RESET}`
                });
            }
        } catch (error) {
            // Drop silent to protect execution loops
        }
    }

    parentPort.on("message", async (msg) => {
        if (msg.type !== "BLOCK") return;
        
        await retryFailedOpportunities();

        try {
            for (let i = 0; i < routerKeys.length; i++) {
                for (let j = 0; j < routerKeys.length; j++) {
                    if (i === j) continue;

                    const buyAddr = ROUTERS[routerKeys[i]];
                    const sellAddr = ROUTERS[routerKeys[j]];

                    for (const route of pathMatrices) {
                        // View operations hit readProvider bypass
                        const result = await vaultContractRead.findBestFlashLoanSize(
                            buyAddr, sellAddr, CANDIDATE_SIZES_6_DECIMALS, route.pathToToken, route.pathToUSDC
                        ).catch(() => null);

                        if (!result) continue;

                        const grossProfit = Number(ethers.formatUnits(result.estimatedProfit, 6));

                        if (grossProfit >= MINIMUM_PROFIT_USDC) {
                            const inputTierStr = Number(ethers.formatUnits(result.amountIn, 6)).toLocaleString('en-US', { minimumFractionDigits: 2 });
                            const minerTipBribe = grossProfit * 0.35;
                            const netProfit = grossProfit - minerTipBribe;

                            parentPort.postMessage({
                                type: "LOG",
                                data: `\n${YELLOW}⚡ MEV MATCH [Shard #${id}]: ${routerKeys[i]} ➔ ${routerKeys[j]}${RESET}\n` +
                                      `   ├── Size Tiered: $${inputTierStr} USDC\n` +
                                      `   └── Expected Net: +$${netProfit.toFixed(6)} USDC`
                            });

                            try {
                                const txDeadline = Math.floor(Date.now() / 1000) + 30;
                                
                                // Execution transaction pushes to relayProvider via vaultContractWrite
                                const tx = await vaultContractWrite.executeBestFlashLoanArbitrage(
                                    buyAddr, 
                                    sellAddr, 
                                    CANDIDATE_SIZES_6_DECIMALS, 
                                    route.pathToToken, 
                                    route.pathToUSDC, 
                                    txDeadline, 
                                    { gasLimit: 700000n }
                                );
                                
                                const receipt = await tx.wait(1);

                                if (receipt && receipt.status === 1) {
                                    parentPort.postMessage({
                                        type: "PROFIT",
                                        amount: netProfit
                                    });
                                    
                                    parentPort.postMessage({
                                        type: "LOG",
                                        data: `${GREEN}✅ [BUNDLE DETECTED ON-CHAIN] Block #${receipt.blockNumber} | Net Yield: +$${netProfit.toFixed(6)} USDC${RESET}\n`
                                    });
                                }
                            } catch (txError) {
                                failedOpportunities.push({
                                    buyAddr, sellAddr, pathToToken: route.pathToToken, pathToUSDC: route.pathToUSDC
                                });
                            }
                        }
                    }
                }
            }
        } catch (err) {
            // Direct error isolation
        }
    });
}
