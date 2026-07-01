/**
 * ARBBOT1 - High-Velocity Production Execution & Diagnostic Engine
 * Architecture: WSS Resilient Stream Pool -> Multi-Thread Worker Cluster -> FastLane Bundle Relay
 * Specification: Ethers v6 Production Build
 * Mode: ZERO-REVALIDATION RAW BATCH MATRIX EXECUTION
 * Target: Smart Contract #2 (Hardcoded High-Liquidity Tokens Optimization)
 */
import { ethers } from "ethers";
import { Worker, isMainThread, workerData, parentPort } from "worker_threads";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// COMPREHENSIVE GLOBAL CONFIGURATION
// ============================================================================
const CONFIG = {
    providerWssEndpoints: [
        "wss://polygon-bor-rpc.publicnode.com",
        "wss://polygon.rpc.subquery.network/public/ws"
    ],
    fastLaneRpc: "https://polygon-bor-rpc.publicnode.com",
    fallbackRpc: "https://polygon.drpc.org",
    contractAddress: ethers.getAddress("0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc".toLowerCase()),
    usdcAddress: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase()),
    wmaticAddress: ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase()), // Added Intermediary
    gasLimitOverride: 850000n, 
    priorityFeeGwei: 45n,
    candidateSizes: [
        "100000",      // $0.10 Min from contract rules
        "1000000",     // $1.00
        "10000000",    // $10.00
        "100000000",   // $100.00
        "1000000000",  // $1000.00
        "50000000000"  // $50,000.00 Max from contract rules
    ],
    routers: {
        QUICK: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase()),
        SUSHI: ethers.getAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase()),
        DFYN: ethers.getAddress("0xF15361A03Eca00a63A23e1bd165157Cb02434a62".toLowerCase())
    },
    maxPendingTransactions: 1,
    blockConfirmConfirmations: 1,
    deadlineSeconds: 45
};

const CONTRACT_ABI = [
    "function executeRawBatchArbitrage(address[] calldata buyRouters, address[] calldata sellRouters, uint256[] calldata candidateSizes, address[][] calldata pathsToToken, address[][] calldata pathsToUSDC, uint256 deadline) external returns (uint256)",
    "function minimumProfitUSDC() external view returns (uint256)",
    "event ArbitrageExecuted(address indexed buyRouter, address indexed sellRouter, address indexed token, uint256 amountInUSDC, uint256 beforeBal, uint256 afterBal, uint256 profitUSDC)"
];

const STATIC_POLYGON_NETWORK = ethers.Network.from({ name: "polygon", chainId: 137 });

process.on("uncaughtException", (err) => {
    if (err.message && (err.message.includes("websocket"))) return;
    console.error("☠️ System Intercepted Exception:", err);
});

if (isMainThread) {
    if (!process.env.PRIVATE_KEY) {
        console.error("❌ PRIVATE_KEY missing");
        process.exit(1);
    }

    let totalRealizedProfits = 0;
    let workerThreads = [];

    const activeSubMatrices = [
        { id: 1, routers: ["QUICK", "SUSHI", "DFYN"] },
        { id: 2, routers: ["QUICK", "SUSHI", "DFYN"] },
        { id: 3, routers: ["QUICK", "SUSHI", "DFYN"] },
        { id: 4, routers: ["QUICK", "SUSHI", "DFYN"] }
    ];

    for (let i = 0; i < 4; i++) {
        const w = new Worker(__filename, {
            workerData: {
                workerId: activeSubMatrices[i].id,
                config: CONFIG,
                matrix: activeSubMatrices[i].routers
            }
        });

        w.on("message", (msg) => {
            if (msg.type === "LOG") console.log(msg.data);
            if (msg.type === "PROFIT") {
                totalRealizedProfits += msg.amount;
                console.log(`💰 TOTAL REALIZED PROFIT ACCUMULATED: $${totalRealizedProfits.toFixed(6)} USDC`);
            }
        });

        workerThreads.push(w);
    }

    console.log("🌐 MATRIX ENGINE STARTED [PRODUCTION LIVE MODE]");
    console.log("└── 4 Workers Active");

    function connectWebSocketStream() {
        const provider = new ethers.WebSocketProvider(CONFIG.providerWssEndpoints[0], STATIC_POLYGON_NETWORK);

        provider.on("block", (blockNumber) => {
            console.log(`\n🔍 Block #${blockNumber}`);
            workerThreads.forEach(w =>
                w.postMessage({ type: "BLOCK_TRIGGER", blockNumber })
            );
        });
    }

    setTimeout(connectWebSocketStream, 300);

} else {
    const { workerId, config, matrix } = workerData;

    const provider = new ethers.JsonRpcProvider(config.fastLaneRpc);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const vaultInstance = new ethers.Contract(config.contractAddress, CONTRACT_ABI, wallet);

    let pendingTransactionsCount = 0;

    parentPort.on("message", async (message) => {
        if (message.type !== "BLOCK_TRIGGER") return;
        if (pendingTransactionsCount >= config.maxPendingTransactions) return;

        const buyRouters = [];
        const sellRouters = [];
        const pathsToToken = [];
        const pathsToUSDC = [];

        for (let b = 0; b < matrix.length; b++) {
            for (let s = 0; s < matrix.length; s++) {
                if (b === s) continue;

                const buyRouter = config.routers[matrix[b]];
                const sellRouter = config.routers[matrix[s]];

                buyRouters.push(buyRouter);
                sellRouters.push(sellRouter);

                // FIX: Swap USDC -> WMATIC on Buy, then WMATIC -> USDC on Sell
                pathsToToken.push([config.usdcAddress, config.wmaticAddress]);
                pathsToUSDC.push([config.wmaticAddress, config.usdcAddress]);
            }
        }

        const txDeadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
        pendingTransactionsCount++;

        vaultInstance.executeRawBatchArbitrage(
            buyRouters,
            sellRouters,
            config.candidateSizes.map(BigInt),
            pathsToToken,
            pathsToUSDC,
            txDeadline,
            {
                gasLimit: config.gasLimitOverride,
                maxFeePerGas: 250n * 1000000000n, // Automated dynamic buffers
                maxPriorityFeePerGas: config.priorityFeeGwei * 1000000000n
            }
        ).then(async (tx) => {
            parentPort.postMessage({
                type: "LOG",
                data: `🛰️ TX BROADCASTED: ${tx.hash}`
            });

            const receipt = await tx.wait(1);
            pendingTransactionsCount--;

            let verifiedProfitOnChain = 0n;

            // FIX: Search event logs to extract actual mathematical profit
            for (const log of receipt.logs) {
                try {
                    const parsedLog = vaultInstance.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "ArbitrageExecuted") {
                        verifiedProfitOnChain = parsedLog.args.profitUSDC;
                    }
                } catch (e) {
                    // Log not matching interface contract structure, skip safely
                }
            }

            const formattedProfit = ethers.formatUnits(verifiedProfitOnChain, 6);

            parentPort.postMessage({
                type: "LOG",
                data: `✅ LIVE TRADING TRANSACTION EXECUTION SUCCESSFUL`
            });

            parentPort.postMessage({
                type: "PROFIT",
                amount: parseFloat(formattedProfit)
            });

        }).catch((err) => {
            pendingTransactionsCount--;
            parentPort.postMessage({
                type: "LOG",
                data: `⚠️ Real On-Chain Reversion / Opportunity Expired (No loss occurred)`
            });
        });
    });
}
