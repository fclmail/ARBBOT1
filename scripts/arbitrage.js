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
   EXACT CONFIGURATION PARAMETERS (Optimized for Cross-DEX Volatility)
   ========================================================================= */
const BASE_TRADE = ethers.parseUnits("0.0200", 6);      // Raised to clear AMM protocol fee thresholds
const MIN_PROFIT = ethers.parseUnits("0.000005", 6);     // Relativized minimum threshold targets 
const GAS_COST_USDC = ethers.parseUnits("0.0003", 6);
const MAX_TRADES_PER_BATCH = 3; 
const SCAN_CONCURRENCY_CHUNKS = 60;                   // Balanced network throughput threshold

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* --- ACCURATE SMART CONTRACT INFRASTRUCTURE ABIS --- */
const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)"
];
const ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];
const VAULT_ABI = [
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external",
    "function withdraw(uint256 amount) external"
];

/* --- HIGH-LIQUIDITY CORE ROUTERS --- */
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* --- HIGH-VOLUME PRIORITY CORE TOKENS --- */
const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13"
};

const WITHDRAW_THRESHOLD = ethers.parseUnits("3001112", 6);
const WITHDRAW_PERCENT = 10n;

const fmt = x => ethers.formatUnits(x, 6);

/* =========================================================================
   MEM-SAFE LOCAL CACHE
   ========================================================================= */
let quoteCache = new Map();
const CACHE_TTL = 1000; 

function getCachedQuote(router, path) {
    const key = `${router}-${path.join('-')}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.value;
    }
    return undefined;
}

function setCachedQuote(router, path, value) {
    const key = `${router}-${path.join('-')}`;
    quoteCache.set(key, { value, timestamp: Date.now() });
}

/* =========================================================================
   CONNECTIONS INFRASTRUCTURE
   ========================================================================= */
function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
}

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    vaultContract = new ethers.Contract(CONTRACT_ADDRESS, VAULT_ABI, wallet);
    
    routerContracts = Object.fromEntries(
        Object.values(routers).map(addr => [
            addr,
            new ethers.Contract(addr, ROUTER_ABI, provider)
        ])
    );
}

/* =========================================================================
   CROSS-DEX MULTI-HOP PROCESSING ENGINE
   ========================================================================= */
async function getLiveQuote(router, amount, path) {
    if (amount <= 0n) return null;
    const cached = getCachedQuote(router, path);
    if (cached !== undefined) return cached;

    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        const result = out[out.length - 1];
        setCachedQuote(router, path, result);
        return result;
    } catch {
        setCachedQuote(router, path, null);
        return null;
    }
}

// Scans an entire structural combo across mismatched routers
async function scanCrossDexOpportunity(buyRouter, sellRouter, tokenA, tokenB) {
    const path1 = [USDC_ADDRESS, tokenA, tokenB];
    const outTokenB = await getLiveQuote(buyRouter, BASE_TRADE, path1);
    if (!outTokenB) return null;

    const path2 = [tokenB, USDC_ADDRESS];
    const finalUSDC = await getLiveQuote(sellRouter, outTokenB, path2);
    if (!finalUSDC) return null;

    const profit = finalUSDC - BASE_TRADE;
    if (profit <= 0n || profit < MIN_PROFIT) return null;

    console.log(`ðŸŽ¯ TARGET GAP DETECTED: Buy Router: ${buyRouter} âž” Sell Router: ${sellRouter}`);
    console.log(`   Path Variation: USDC âž” ${tokenA} âž” ${tokenB} âž” USDC`);
    console.log(`   Expected Returns: +${fmt(profit)} USDC`);

    return {
        buyRouter,
        sellRouter,
        amountIn: BASE_TRADE,
        pathToToken: path1,
        pathToUSDC: path2,
        expectedProfit: profit
    };
}

function buildStructuralVariations() {
    const tokens = Object.values(TOKENS);
    const routerAddresses = Object.values(routers);
    const matrix = [];

    for (const buyR of routerAddresses) {
        for (const sellR of routerAddresses) {
            if (buyR === sellR) continue; // Must be cross-dex variation
            for (const a of tokens) {
                for (const b of tokens) {
                    if (a === b) continue;
                    matrix.push({ buyRouter: buyR, sellRouter: sellR, tokenA: a, tokenB: b });
                }
            }
        }
    }
    return matrix;
}

/* =========================================================================
   ARBITRAGE MAIN ENGINE
   ========================================================================= */
class LiveArbitrageEngine {
    constructor() {
        this.isExecuting = false;
        this.structuralVariations = buildStructuralVariations();
    }

    async init() {
        console.log("ðŸš€ BOT STARTED â€” LIVE HIGH-DENSITY ARBITRAGE ENGINE");
        console.log(`ðŸ“¡ Connected Provider Node: ${provider._getConnection().url}`);
        console.log(`ðŸ§³ Active Verification Wallet: ${wallet.address}`);
        console.log(`ðŸ“Š Scan Size: ${this.structuralVariations.length} Cross-DEX Variant Target Paths\n`);

        provider.on("block", async (blockNumber) => {
            console.log(`--- [BLOCK ${blockNumber}] Scanning Cross-Protocol Inefficiencies ---`);
            
            if (this.isExecuting) {
                return;
            }

            try {
                quoteCache.clear(); // Keep memory completely clear
                await this.processArbitrageOpportunities();
            } catch (err) {
                console.error("âš ï¸ Scan Warning:", err.message);
            }
        });
    }

    async processArbitrageOpportunities() {
        const foundTrades = [];

        for (let i = 0; i < this.structuralVariations.length; i += SCAN_CONCURRENCY_CHUNKS) {
            const chunk = this.structuralVariations.slice(i, i + SCAN_CONCURRENCY_CHUNKS);
            const scanPromises = chunk.map(v => 
                scanCrossDexOpportunity(v.buyRouter, v.sellRouter, v.tokenA, v.tokenB).catch(() => null)
            );

            const results = await Promise.all(scanPromises);
            for (const r of results) {
                if (r !== null) {
                    foundTrades.push(r);
                    if (foundTrades.length >= MAX_TRADES_PER_BATCH) break;
                }
            }

            if (foundTrades.length >= MAX_TRADES_PER_BATCH) break;
        }

        if (foundTrades.length === 0) {
            return;
        }

        await this.executeBatchTransaction(foundTrades.slice(0, MAX_TRADES_PER_BATCH));
    }

    async executeBatchTransaction(trades) {
        try {
            this.isExecuting = true;
            console.log("\nðŸ”¥ DISPATCHING FLASH-BATCH TO REVENUE ENFORCER...");
            
            let totalCapital = 0n;
            let totalExpectedProfit = 0n;
            for (const t of trades) {
                totalCapital += t.amountIn;
                totalExpectedProfit += t.expectedProfit;
            }

            if (totalExpectedProfit < GAS_COST_USDC) {
                console.log("âŒ SKIPPED: Profits fall short of gas allowance limitations.\n");
                return;
            }

            const contractBeforeBalance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
            const feeData = await provider.getFeeData();

            const batchStruct = {
                buyRouters: trades.map(t => t.buyRouter),
                sellRouters: trades.map(t => t.sellRouter),
                amountsInUSDC: trades.map(t => t.amountIn),
                pathsToToken: trades.map(t => t.pathToToken),
                pathsToUSDC: trades.map(t => t.pathToUSDC),
                deadline: Math.floor(Date.now() / 1000) + 60
            };

            const tx = await vaultContract.executeFlashBatchArbitrage(batchStruct, {
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                gasLimit: 950000 
            });

            console.log(`âœ‰ï¸ Dispatched Hash: ${tx.hash}`);
            await provider.waitForTransaction(tx.hash);
            
            const contractAfterBalance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
            const actualProfit = contractAfterBalance > contractBeforeBalance ? contractAfterBalance - contractBeforeBalance : 0n;

            console.log(`âœ… EXECUTED TRANSACTION MINED`);
            console.log(`   REALIZED PROFIT: +${fmt(actualProfit)} USDC ðŸš€\n`);

            await this.topUpGas();

        } catch (txError) {
            console.error("ðŸ›‘ Submission Block Error:", txError.message);
        } finally {
            this.isExecuting = false;
        }
    }

    async topUpGas() {
        try {
            const contractBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
            if (contractBal < WITHDRAW_THRESHOLD) return;

            const amount = (contractBal * WITHDRAW_PERCENT) / 100n;
            const withdrawTx = await vaultContract.withdraw(amount);
            await withdrawTx.wait();
            console.log(`âš¡ Auto-Withdrawn For Gas Reserve Gas Conversion.`);
        } catch (e) {
            console.log(`âš ï¸ Gas conversion structural delay skipped.`);
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
            provider = newProvider();
            rebuildContracts();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
})();
