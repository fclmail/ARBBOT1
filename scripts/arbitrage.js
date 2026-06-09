import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* =========================================================================
   LIVE BLOCKCHAIN PROVIDER & WALLET INFRASTRUCTURE
   ========================================================================= */
const RPCS = [
    "https://polygon-bor-rpc.publicnode.com"
];
let rpcIndex = 0;

let provider;
let wallet;
let usdcContract;
let vaultContract;
let routerContracts;

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error("ðŸ›‘ CONFIG ERROR: PRIVATE_KEY is missing from environment variables.");
    process.exit(1);
}

/* =========================================================================
   EXACT CONFIGURATION PARAMETERS
   ========================================================================= */
const BASE_TRADE = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.00021", 6);
const GAS_COST_USDC = ethers.parseUnits("0.00003", 6);
const BATCH_SIZE = 5;

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* --- ACCURATE SMART CONTRACT INFRASTRUCTURE ABIS --- */
const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];
const ROUTER_ABI = ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"];
const VAULT_ABI = [
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external"
];

/* --- HARD TARGET DIVERSIFIED DEX NETWORKS --- */
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

const fmt = x => ethers.formatUnits(x, 6);

/* =========================================================================
   CONNECTIONS MANAGEMENT Framework
   ========================================================================= */
function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    vaultContract = new ethers.Contract(CONTRACT_ADDRESS, VAULT_ABI, wallet);
    
    // FIX: Removed the undefined 'routerAbi' fallback reference entirely
    routerContracts = Object.fromEntries(
        Object.values(routers).map(addr => [
            addr,
            new ethers.Contract(addr, ROUTER_ABI, provider)
        ])
    );
}

/* =========================================================================
   TRIANGULAR ON-CHAIN PATH SCANNER (LIVE CALCULATION)
   ========================================================================= */
async function getLiveQuote(router, amount, path) {
    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        return out[out.length - 1];
    } catch {
        return null;
    }
}

async function scanPath(router, tokenA, tokenB) {
    const path = [USDC_ADDRESS, tokenA, tokenB, USDC_ADDRESS];
    
    const out1 = await getLiveQuote(router, BASE_TRADE, [path[0], path[1]]);
    if (!out1) return null;
    
    const out2 = await getLiveQuote(router, out1, [path[1], path[2]]);
    if (!out2) return null;
    
    const out3 = await getLiveQuote(router, out2, [path[2], path[3]]);
    if (!out3) return null;

    const profit = out3 - BASE_TRADE;
    if (profit < MIN_PROFIT) return null;

    return {
        router,
        amountIn: BASE_TRADE,
        pathToToken: [path[0], path[1], path[2]],
        pathToUSDC: [path[2], path[3]],
        expectedProfit: profit
    };
}

/* =========================================================================
   ARBITRAGE MAIN ENGINE
   ========================================================================= */
class LiveArbitrageEngine {
    constructor() {
        this.isExecuting = false;
    }

    async init() {
        console.log("ðŸš€ BOT STARTED â€” LIVE BLOCKCHAIN ENGINE ACTIVE");
        console.log(`ðŸ“¡ Linked Node Provider: ${provider._getConnection().url}`);
        console.log(`ðŸ§³ Execution Wallet Key Authorized: ${wallet.address}`);
        console.log(`ðŸ“Š Parameters Loaded: Min Profit Target = ${fmt(MIN_PROFIT)} USDC\n`);

        provider.on("block", async (blockNumber) => {
            console.log(`\n--- [BLOCK ${blockNumber}] Monitoring Live Pool Depths ---`);
            
            if (this.isExecuting) {
                console.log("â³ Execution loop busy. Skipping current block sequence to avoid transaction collision.");
                return;
            }

            try {
                await this.processArbitrageOpportunities();
            } catch (err) {
                console.error("âš ï¸ Operational Scan Warning:", err.message);
            }
        });
    }

    async processArbitrageOpportunities() {
        console.log("ðŸ” [PARALLEL SCAN] Running triangular calculations...");
        const foundTrades = [];
        const routerList = Object.values(routers);
        const tokenList = Object.values(TOKENS);

        for (const r of routerList) {
            for (const tA of tokenList) {
                for (const tB of tokenList) {
                    if (tA === tB) continue;
                    const trade = await scanPath(r, tA, tB);
                    if (trade) {
                        foundTrades.push(trade);
                        if (foundTrades.length >= BATCH_SIZE) break;
                    }
                }
                if (foundTrades.length >= BATCH_SIZE) break;
            }
            if (foundTrades.length >= BATCH_SIZE) break;
        }

        if (foundTrades.length === 0) {
            console.log("â„¹ï¸ No profitable triangular spreads found in this block.");
            return;
        }

        await this.executeBatchTransaction(foundTrades);
    }

    async executeBatchTransaction(trades) {
        try {
            this.isExecuting = true;
            console.log("\nðŸ”¥ EXECUTING BATCH VIA VAULTARBITRAGEENFORCER...");
            
            let totalCapital = 0n;
            let totalExpectedProfit = 0n;
            for (const t of trades) {
                totalCapital += t.amountIn;
                totalExpectedProfit += t.expectedProfit;
            }

            console.log(`USED CAPITAL: ${fmt(totalCapital)} USDC`);
            console.log(`EXPECTED PROFIT: ${fmt(totalExpectedProfit)} USDC`);

            if (totalExpectedProfit < GAS_COST_USDC) {
                console.log("âŒ SKIPPED: Calculated block yields fall beneath network gas margins.\n");
                return;
            }

            const contractBeforeBalance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
            const feeData = await provider.getFeeData();

            const batchStruct = {
                buyRouters: trades.map(t => t.router),
                sellRouters: trades.map(t => t.router),
                amountsInUSDC: trades.map(t => t.amountIn),
                pathsToToken: trades.map(t => t.pathToToken),
                pathsToUSDC: trades.map(t => t.pathToUSDC),
                deadline: Math.floor(Date.now() / 1000) + 60
            };

            const tx = await vaultContract.executeFlashBatchArbitrage(batchStruct, {
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                gasLimit: 650000 
            });

            console.log(`âœ‰ï¸ Transaction broadcasted to public mempool. Hash: ${tx.hash}`);
            console.log("â³ Awaiting network mining validation...");

            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                const contractAfterBalance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
                const actualProfit = contractAfterBalance - contractBeforeBalance;

                console.log(`\nâœ… ARBITRAGE BATCH MINED SUCCESSFULLY IN BLOCK ${receipt.blockNumber}`);
                console.log(`   Gas Consumed:     ${receipt.gasUsed.toString()}`);
                console.log(`   CONTRACT BEFORE:  ${fmt(contractBeforeBalance)} USDC`);
                console.log(`   CONTRACT AFTER:   ${fmt(contractAfterBalance)} USDC`);
                console.log(`   REALIZED PROFIT:  +${fmt(actualProfit)} USDC ðŸš€`);
            } else {
                console.error("ðŸ›‘ Internal trade step execution sequence threw an unhandled contract error.");
            }

        } catch (txError) {
            console.error("ðŸ›‘ Transaction failed or rejected by node:", txError.message);
        } finally {
            this.isExecuting = false;
        }
    }
}

/* =========================================================================
   PROTECTED MAIN EXECUTION WRAPPER
   ========================================================================= */
(async function main() {
    provider = newProvider();
    rebuildContracts();

    const engine = new LiveArbitrageEngine();

    while (true) {
        try {
            await engine.init();
            await new Promise(() => {}); 
        } catch (error) {
            console.error("âŒ Process Loop Context Crash:", error.message);
            provider = newProvider();
            rebuildContracts();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
})();
