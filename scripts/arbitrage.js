import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
    "https://polygon-bor-rpc.publicnode.com"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const BASE_TRADE = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.00005", 6);
const BATCH_SIZE = 4;
const SCAN_INTERVAL_MS = 2000;
const MAX_FAILURES = 10;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
    "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const USDC =
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ROUTERS ================= */

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= TOKENS ================= */

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
    UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    BAT: "0x3cef98bb43d732e2f285ee605a8158cde967d219",
    TBTC: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
    MANA: "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
    APOLUSDT: "0x6ab707aca953edaefbc4fd23ba73294241490620"
};

/* ================= ABI ================= */

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)"
];

const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

/* ================= PROVIDER ================= */

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    console.log("🔄 RPC SWITCH:", url);
    return new ethers.JsonRpcProvider(url);
}

/* ================= INIT ================= */

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

    routerContracts = Object.fromEntries(
        Object.entries(routers).map(([k, v]) => [
            k,
            new ethers.Contract(v, routerAbi, provider)
        ])
    );

    console.log("✅ CONTRACTS INITIALIZED");
}

/* ================= PATH GENERATION ================= */

function buildGraph() {
    const graph = {};
    const tokens = Object.values(TOKENS);

    // USDC is always entry point
    graph[USDC] = tokens;

    for (const t of tokens) {
        graph[t] = [...tokens, USDC].filter(x => x !== t);
    }

    return graph;
}

function dfsPaths(graph, start, maxDepth) {
    const results = [];

    function dfs(path, depth) {
        const last = path[path.length - 1];

        if (depth === 0) {
            results.push([...path, USDC]);
            return;
        }

        for (const next of graph[last]) {
            if (path.includes(next)) continue;
            dfs([...path, next], depth - 1);
        }
    }

    dfs([start], maxDepth);

    return results;
}

/* ================= NEW MULTI-DEPTH PATH BUILDER ================= */

function buildTriangularPaths() {
    const graph = buildGraph();
    const allPaths = [];

    // 2-hop, 3-hop, 4-hop
    allPaths.push(...dfsPaths(graph, USDC, 2));
    allPaths.push(...dfsPaths(graph, USDC, 3));
    allPaths.push(...dfsPaths(graph, USDC, 4));

    // Format into router-ready paths
    const formatted = allPaths.map(p => ({
        path: p,
        pathToToken: p.slice(0, -2),
        pathToUSDC: [p[p.length - 2], USDC]
    }));

    console.log("📦 PATHS GENERATED:", formatted.length);
    return formatted;
}

/* ================= GAS ESTIMATION ================= */

async function estimateGasCost() {
    try {
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits("30", "gwei");
        const estimatedGas = 500000n;
        return gasPrice * estimatedGas;
    } catch {
        return ethers.parseEther("0.01");
    }
}

/* ================= OPPORTUNITY FINDER ================= */

async function checkOpportunity(pathData) {
    const { pathToToken, pathToUSDC } = pathData;
    
    try {
        // Use QuickSwap as default router for simulation
        const router = routerContracts["QuickSwap"];
        if (!router) return null;
        
        // Simulate: Buy path (USDC -> token)
        const buyAmounts = await router.getAmountsOut(
            BASE_TRADE,
            pathToToken
        );
        
        if (!buyAmounts || buyAmounts.length < 2) return null;
        
        const tokenAmount = buyAmounts[buyAmounts.length - 1];
        
        // Simulate: Sell path (token -> USDC)
        const sellAmounts = await router.getAmountsOut(
            tokenAmount,
            pathToUSDC
        );
        
        if (!sellAmounts || sellAmounts.length < 2) return null;
        
        const usdcReturn = sellAmounts[sellAmounts.length - 1];
        const profit = usdcReturn - BASE_TRADE;
        
        if (profit > MIN_PROFIT) {
            // Calculate gas costs
            const gasCost = await estimateGasCost();
            // Convert gas cost to USDC (gas is in MATIC, approximate)
            const gasCostInUSDC = gasCost / 1000000n; // Rough approximation
            
            const netProfit = profit - gasCostInUSDC;
            
            if (netProfit > MIN_PROFIT) {
                return {
                    pathData,
                    profit: netProfit,
                    usdcReturn,
                    tokenAmount,
                    router: router
                };
            }
        }
        
        return null;
    } catch (error) {
        // Path might not exist on this router
        return null;
    }
}

/* ================= SCAN ALL PATHS ================= */

async function scanAllOpportunities(paths) {
    console.log("\n🔍 Scanning for opportunities...");
    
    const opportunities = [];
    
    // Process in batches to avoid rate limiting
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        const batch = paths.slice(i, i + BATCH_SIZE);
        
        const promises = batch.map(pathData => 
            checkOpportunity(pathData)
                .then(result => {
                    if (result) opportunities.push(result);
                })
                .catch(() => {})
        );
        
        await Promise.all(promises);
        
        // Small delay between batches
        if (i + BATCH_SIZE < paths.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    // Sort by profit (highest first)
    opportunities.sort((a, b) => b.profit - a.profit);
    
    return opportunities;
}

/* ================= EXECUTION ENGINE ================= */

let consecutiveFailures = 0;
let totalProfitsAccumulated = ethers.parseUnits("0", 6);
let totalTradesExecuted = 0;

async function executeOpportunity(opportunity) {
    const { pathData, profit, router } = opportunity;
    const { pathToToken, pathToUSDC } = pathData;
    
    try {
        console.log(`\n💎 PROFIT FOUND: ${ethers.formatUnits(profit, 6)} USDC`);
        console.log(`📈 Path: ${pathToToken.join(" -> ")} -> ${pathToUSDC.join(" -> ")}`);
        
        // Get router addresses for the batch
        const routerAddresses = Object.values(routers);
        
        // Build batch data for contract
        const batchData = {
            buyRouters: [router.target || router.address || routerAddresses[0]],
            sellRouters: [router.target || router.address || routerAddresses[0]],
            amountsInUSDC: [BASE_TRADE],
            pathsToToken: [pathToToken],
            pathsToUSDC: [pathToUSDC],
            deadline: Math.floor(Date.now() / 1000) + 60
        };
        
        console.log("📤 Sending transaction...");
        
        // Execute the trade
        const tx = await vault.executeFlashBatchArbitrage({
            batch: batchData
        });
        
        console.log(`⏳ TX SENT: ${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            // Success
            totalProfitsAccumulated += profit;
            totalTradesExecuted++;
            consecutiveFailures = 0;
            
            console.log(`✅ SUCCESS | Profit: ${ethers.formatUnits(profit, 6)} USDC`);
            console.log(`💰 Total Accumulated: ${ethers.formatUnits(totalProfitsAccumulated, 6)} USDC`);
            console.log(`📊 Total Trades: ${totalTradesExecuted}`);
            
            return true;
        } else {
            console.log("❌ TX FAILED");
            consecutiveFailures++;
            return false;
        }
    } catch (error) {
        console.log(`⚠️ Execution error: ${error.message}`);
        consecutiveFailures++;
        return false;
    }
}

/* ================= CONTINUOUS SCAN & EXECUTE ================= */

async function continuousArbitrageLoop(paths) {
    console.log("\n🔄 Starting continuous scan loop...");
    console.log(`📊 Scans every ${SCAN_INTERVAL_MS}ms`);
    console.log(`💰 Min profit: ${ethers.formatUnits(MIN_PROFIT, 6)} USDC`);
    console.log(`⚠️ Max failures: ${MAX_FAILURES}`);
    
    while (true) {
        try {
            // Check if we should stop
            if (consecutiveFailures >= MAX_FAILURES) {
                console.error(`💀 TOO MANY FAILURES (${MAX_FAILURES}). Stopping.`);
                break;
            }
            
            // Check provider is still connected
            const network = await provider.getNetwork();
            console.log(`🌐 Network: ${network.name} (chainId: ${network.chainId})`);
            
            // Check USDC balance
            const balance = await usdc.balanceOf(wallet.address);
            console.log(`💳 Balance: ${ethers.formatUnits(balance, 6)} USDC`);
            
            if (balance < BASE_TRADE) {
                console.log("⚠️ Insufficient balance for trades");
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }
            
            // Scan for opportunities
            const scanStart = Date.now();
            const opportunities = await scanAllOpportunities(paths);
            const scanDuration = Date.now() - scanStart;
            
            console.log(`⏱️ Scan took ${scanDuration}ms | Found ${opportunities.length} opportunities`);
            
            if (opportunities.length > 0) {
                // Execute the BEST opportunity (highest profit)
                const best = opportunities[0];
                console.log(`🏆 Best opportunity: ${ethers.formatUnits(best.profit, 6)} USDC profit`);
                
                const executed = await executeOpportunity(best);
                
                if (executed) {
                    console.log(`🎯 Trade executed! Accumulated: ${ethers.formatUnits(totalProfitsAccumulated, 6)} USDC`);
                }
                
                // Refresh paths after trade (prices changed)
                console.log("🔄 Refreshing paths...");
                paths = buildTriangularPaths();
            } else {
                console.log("⏳ No profitable opportunities found");
            }
            
            // Wait before next scan
            console.log(`💤 Waiting ${SCAN_INTERVAL_MS}ms until next scan...`);
            await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
            
        } catch (error) {
            console.error("💥 Loop error:", error.message);
            
            // Rotate RPC on error
            provider = newProvider();
            rebuildContracts();
            
            console.log("🔄 Rebuilding paths...");
            paths = buildTriangularPaths();
            
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

/* ================= MAIN FUNCTION ================= */

(async function main() {
    console.log("🚀 ARBITRAGE BOT STARTED");
    console.log(`📍 Network: Polygon`);
    console.log(`💼 Wallet: ${PRIVATE_KEY.slice(0, 6)}...${PRIVATE_KEY.slice(-4)}`);
    
    provider = newProvider();
    rebuildContracts();
    
    const walletAddress = wallet.address;
    console.log(`🏦 Wallet Address: ${walletAddress}`);
    
    // Check initial balance
    const initialBalance = await usdc.balanceOf(walletAddress);
    console.log(`💰 Initial USDC Balance: ${ethers.formatUnits(initialBalance, 6)} USDC`);
    
    if (initialBalance === 0n) {
        console.error("❌ No USDC balance! Fund your wallet first.");
        process.exit(1);
    }
    
    let paths = buildTriangularPaths();
    console.log(`🧭 Paths generated: ${paths.length}`);
    
    // Start continuous arbitrage
    await continuousArbitrageLoop(paths);
    
    // Final report
    console.log("\n══════════════════════════════════");
    console.log("📊 FINAL SUMMARY");
    console.log("══════════════════════════════════");
    console.log(`✅ Total trades executed: ${totalTradesExecuted}`);
    console.log(`💰 Total profit accumulated: ${ethers.formatUnits(totalProfitsAccumulated, 6)} USDC`);
    
    const finalBalance = await usdc.balanceOf(walletAddress);
    console.log(`💳 Final USDC Balance: ${ethers.formatUnits(finalBalance, 6)} USDC`);
    console.log(`📈 Net Change: ${ethers.formatUnits(finalBalance - initialBalance, 6)} USDC`);
    console.log("══════════════════════════════════\n");
    
    console.log("👋 Bot stopped. Goodbye!");
    
})().catch(error => {
    console.error("💀 FATAL ERROR:", error);
    process.exit(1);
});
