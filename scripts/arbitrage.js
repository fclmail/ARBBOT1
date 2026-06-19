import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ==========================================
// CONFIGURATION
// ==========================================
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const VAULT_CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const ROUTERS = {
    QUICK: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
    SUSHI: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TOKENS = {
    USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    DAI:    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

// ==========================================
// SPECIFIC USDC POOLS TO MONITOR
// ==========================================
const POOLS_TO_MONITOR = [
    // QuickSwap Pools
    { address: "0x853ee4b2a13f8a742d64c8f088be7ba2131f670d", name: "QuickSwap-USDC/WETH" },
    { address: "0x2cf7252e74036d1da831d11089d326296e64a728", name: "QuickSwap-USDC/USDT" },
    { address: "0x6e7a5fafcec6bb1e78bae2a1f0b612012bf14827", name: "QuickSwap-USDC/WMATIC" },
    { address: "0xa3fa99a148fa48d14ed51d610c367c61876997f1", name: "QuickSwap-USDC/DAI" },
    // SushiSwap Pools
    { address: "0x34965ba0ac2451a34a0471f04cca3f990b8dea27", name: "SushiSwap-USDC/WETH" },
    { address: "0x2360d33932e6f5ec9b2a8928b8f9ebc9e6ae4e20", name: "SushiSwap-USDC/USDT" },
];

const ENFORCER_ABI = [
    "function simulateArbitrageProfit(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC) public view returns (uint256 estimatedFinalUSDC, uint256 estimatedProfit)",
    "function executeAaveFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function minimumProfitUSDC() view returns (uint256)"
];

const SWAP_ABI = [
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
];

// ==========================================
// BUILD FOCUSED PATHS (fewer, more relevant)
// ==========================================
function buildMultiHopCrossExchangePaths() {
    const tokens = Object.values(TOKENS);
    const paths = [];
    
    // 2-hop: USDC -> Token -> USDC (direct arb across exchanges)
    for (const token of tokens) {
        paths.push({
            hops: 2,
            pathToToken: [USDC_ADDRESS, token],
            pathToUSDC: [token, USDC_ADDRESS]
        });
    }
    
    // 3-hop: USDC -> WETH -> Token -> USDC (triangular)
    for (const token of tokens) {
        if (token === TOKENS.WETH) continue;
        paths.push({
            hops: 3,
            pathToToken: [USDC_ADDRESS, TOKENS.WETH, token],
            pathToUSDC: [token, USDC_ADDRESS]
        });
    }
    
    return paths;
}

// ==========================================
// MAIN BOT
// ==========================================
async function main() {
    console.log("🚀 EVENT-DRIVEN ARBITRAGE LISTENER");
    
    // Use HTTP for reliable polling, WSS for fast block updates
    const httpProvider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
    const wssProvider = new ethers.WebSocketProvider("wss://polygon-bor-rpc.publicnode.com");
    
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
    const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, ENFORCER_ABI, wallet);
    
    const paths = buildMultiHopCrossExchangePaths();
    const capitalTiers = ["500", "1000", "5000"];
    
    console.log(`📊 Monitoring ${POOLS_TO_MONITOR.length} pools across QuickSwap & SushiSwap`);
    console.log(`📊 ${paths.length} arbitrage paths configured`);
    console.log(`⚡ Listening for swaps to trigger opportunity scans...\n`);
    
    let lastScannedBlock = 0;
    let scanning = false;
    
    // Listen for blocks via WSS (fast)
    wssProvider.on("block", async (blockNumber) => {
        if (scanning || blockNumber <= lastScannedBlock) return;
        
        // Only scan every 2 blocks to avoid overload
        if (blockNumber % 2 !== 0) return;
        
        scanning = true;
        lastScannedBlock = blockNumber;
        
        try {
            // Check each monitored pool for recent swaps
            let swapsFound = false;
            
            for (const pool of POOLS_TO_MONITOR) {
                const poolContract = new ethers.Contract(pool.address, SWAP_ABI, httpProvider);
                
                const events = await poolContract.queryFilter(
                    poolContract.filters.Swap(),
                    blockNumber - 2,
                    blockNumber
                );
                
                if (events.length > 0) {
                    if (!swapsFound) {
                        console.log(`\n🔔 [BLOCK #${blockNumber}] Swaps detected — scanning for arb opportunities...`);
                        swapsFound = true;
                    }
                    console.log(`   ${pool.name}: ${events.length} swap(s)`);
                }
            }
            
            // Only scan for arb if swaps were detected
            if (swapsFound) {
                await scanForOpportunities(vaultContract, paths, capitalTiers, blockNumber);
            }
            
        } catch (err) {
            // Silently handle
        } finally {
            scanning = false;
        }
    });
    
    wssProvider.on("error", () => {
        console.log("⚠️ WSS error, reconnecting...");
        // Auto-reconnect handled by provider
    });
}

async function scanForOpportunities(vaultContract, paths, capitalTiers, blockNumber) {
    console.log(`   🔎 Running ${paths.length * 2 * capitalTiers.length} simulations...`);
    
    const promises = [];
    
    for (const path of paths) {
        for (const pair of [
            { buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI, name: "Quick->Sushi" },
            { buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK, name: "Sushi->Quick" }
        ]) {
            for (const tier of capitalTiers) {
                const amount = ethers.parseUnits(tier, 6);
                
                promises.push(
                    vaultContract.simulateArbitrageProfit(
                        pair.buy, pair.sell, amount,
                        path.pathToToken, path.pathToUSDC
                    )
                    .then(([final, profit]) => {
                        if (profit > 0n) {
                            console.log(`   ✅ PROFIT: ${pair.name} | $${tier} | ${ethers.formatUnits(profit, 6)} USDC`);
                            return { profit, pair, amount, path, tier };
                        }
                        return null;
                    })
                    .catch(() => null)
                );
            }
        }
    }
    
    const results = await Promise.all(promises);
    const profitable = results.filter(r => r !== null && r.profit > 10n); // > 0.00001 USDC
    
    if (profitable.length > 0) {
        // Sort by profit descending
        profitable.sort((a, b) => b.profit > a.profit ? 1 : -1);
        
        const best = profitable[0];
        console.log(`\n🎯 EXECUTING: ${best.pair.name} | Profit: ${ethers.formatUnits(best.profit, 6)} USDC`);
        
        try {
            const tx = await vaultContract.executeAaveFlashLoanArbitrage(
                best.pair.buy, best.pair.sell, best.amount,
                best.path.pathToToken, best.path.pathToUSDC,
                Math.floor(Date.now() / 1000) + 30,
                { gasLimit: 980000 }
            );
            console.log(`🚀 TX SENT: ${tx.hash}`);
            await tx.wait();
            console.log(`✅ EXECUTED in block`);
        } catch (e) {
            console.log(`❌ Execution failed: ${e.message?.slice(0, 100)}`);
        }
    } else {
        console.log(`   ❌ No profitable opportunities found`);
    }
}

main().catch(console.error);
