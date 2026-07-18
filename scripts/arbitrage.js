import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

/* ==========================================================================
   1. NETWORK, PROVIDER, AND CONFIGURATION KEYS
   ========================================================================== */
const RPC_URL = process.env.RPC_URL || "https://polygon-mainnet.chainstacklabs.com";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBITRAGE_CONTRACT_ADDRESS = process.env.ARBITRAGE_CONTRACT || "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

// Router Addresses on Polygon
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

// Core Multi-Hop Assets + JS1's duplicate array profile to match exact scanning footprint
const TOKENS = {
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    CRV_1: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV_2: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV_3: "0x172370d5cd63279efa6d502dab29171933a610af",
    QUICK_1: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    QUICK_2: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
    UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

// Target execution parameters matched down to JS1's Micro Specs
const TRADE_AMOUNT_USDC = ethers.parseUnits("0.02", 6); // $0.02 Micro capital target
const MIN_PROFIT_USDC = ethers.parseUnits("0.0002", 6); // $0.0002 Micro target filter

/* ==========================================================================
   2. MINIMAL ABIs REQUIRED FOR ROUTING & TELEMETRY
   ========================================================================== */
const ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)"
];

const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)"
];

const ARBITRAGE_CONTRACT_ABI = [
    "function executeFlashBatchArbitrage(address[] calldata routers, address[][] calldata paths, uint256[] calldata amounts) external"
];

/* ==========================================================================
   3. TIME-BASED CACHE ENGINE (PORTED FROM JS1)
   ========================================================================== */
const quoteCache = new Map();
const CACHE_TTL = 1000; // 1 second Time-to-Live

async function getCachedQuote(routerContract, amountIn, tokenPath) {
    const cacheKey = `${routerContract.target}-${tokenPath.join('-')}-${amountIn.toString()}`;
    const cached = quoteCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return cached.value;
    }

    try {
        const amountsOut = await routerContract.getAmountsOut(amountIn, tokenPath);
        const finalAmount = BigInt(amountsOut[amountsOut.length - 1]);
        quoteCache.set(cacheKey, { value: finalAmount, timestamp: Date.now() });
        return finalAmount;
    } catch (err) {
        // Cache failures briefly to limit RPC spam on non-existent paths
        quoteCache.set(cacheKey, { value: null, timestamp: Date.now() });
        return null;
    }
}

/* ==========================================================================
   4. SAME TOKEN LOOP PATH BUILDER (PORTED FROM JS1)
   ========================================================================== */
function buildTriangularPaths() {
    let paths = [];
    const tokensArray = Object.values(TOKENS);
    const baseAsset = TOKENS.USDC;

    // Generates cross loops including the duplicate/overlapping token strings
    for (const a of tokensArray) {
        for (const b of tokensArray) {
            if (a === b) continue; 
            paths.push([baseAsset, a, b, baseAsset]);
        }
    }
    return paths;
}

/* ==========================================================================
   5. PARALLEL TIMED SCANNER
   ========================================================================== */
async function parallelScan(tokenPaths, routerContractsArray) {
    const opportunities = [];

    const scanPromises = tokenPaths.flatMap((path) => {
        return routerContractsArray.map(async (routerContract) => {
            const amountOut = await getCachedQuote(routerContract, TRADE_AMOUNT_USDC, path);
            
            if (amountOut) {
                const profit = amountOut - TRADE_AMOUNT_USDC;
                if (profit >= MIN_PROFIT_USDC) {
                    console.log(`🎯 TRI FOUND on ${routerContract.target.slice(0,6)}: 0.02 → ${ethers.formatUnits(amountOut, 6)} | PROFIT: ${ethers.formatUnits(profit, 6)}`);
                    opportunities.push({
                        router: routerContract.target,
                        path: path,
                        amount: TRADE_AMOUNT_USDC,
                        expectedOutput: amountOut
                    });
                }
            }
        });
    });

    await Promise.all(scanPromises);
    return opportunities;
}

/* ==========================================================================
   6. ZERO REVALIDATION PIPELINE
   ========================================================================== */
async function executeArbitrageZeroRevalidation(arbitrageContract, usdcContract, trades) {
    if (trades.length === 0) return;

    // Limit execution payload to a max chunk size per batch transaction
    const activeTrades = trades.slice(0, 4);

    const payload = {
        routers: activeTrades.map(t => t.router),
        paths: activeTrades.map(t => t.path),
        amounts: activeTrades.map(t => t.amount)
    };

    try {
        const contractBalanceBefore = BigInt(await usdcContract.balanceOf(arbitrageContract.target));
        console.log(`\n🔥 EXECUTING BATCH (${activeTrades.length} routes)`);
        console.log(`[BALANCE BEFORE] ${ethers.formatUnits(contractBalanceBefore, 6)} USDC`);

        const txOptions = {
            gasLimit: 1500000n, 
            maxFeePerGas: ethers.parseUnits("250", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("40", "gwei")
        };

        const txResponse = await arbitrageContract.executeFlashBatchArbitrage(
            payload.routers,
            payload.paths,
            payload.amounts,
            txOptions
        );

        console.log(`📡 Broadcasted: ${txResponse.hash}`);
        const txReceipt = await txResponse.wait(1);
        
        const contractBalanceAfter = BigInt(await usdcContract.balanceOf(arbitrageContract.target));
        console.log(`[BALANCE AFTER]  ${ethers.formatUnits(contractBalanceAfter, 6)} USDC`);

        const netProfit = contractBalanceAfter - contractBalanceBefore;
        console.log(`REAL PROFIT:    ${ethers.formatUnits(netProfit, 6)} USDC`);

    } catch (criticalError) {
        console.error(`❌ Execution boundary fallback: ${criticalError.message}`);
    }
}

/* ==========================================================================
   7. RUNTIME ENTRYPOINT (CONTINUOUS EVENT LOOP)
   ========================================================================== */
async function main() {
    if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY environment variable missing.");

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`🔑 Wallet Address: ${wallet.address}`);

    const usdcContract = new ethers.Contract(TOKENS.USDC, ERC20_ABI, provider);
    const arbitrageContract = new ethers.Contract(ARBITRAGE_CONTRACT_ADDRESS, ARBITRAGE_CONTRACT_ABI, wallet);

    const routerContractsArray = Object.values(routers).map(
        address => new ethers.Contract(address, ROUTER_ABI, provider)
    );

    const tokenPaths = buildTriangularPaths();
    console.log(`🚀 Engine hot. Ready to stream scans on ${tokenPaths.length} multi-hop tracks.`);

    // Continuous loop framework matching JS1 style instead of waiting for block listeners
    while (true) {
        try {
            const discoveredTrades = await parallelScan(tokenPaths, routerContractsArray);

            if (discoveredTrades.length > 0) {
                await executeArbitrageZeroRevalidation(arbitrageContract, usdcContract, discoveredTrades);
            }
            
            // Short tick throttle to avoid getting ratelimited by the public node RPC
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (loopError) {
            console.error(`⚠️ Cycle iteration error: ${loopError.message}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

main().catch((fatalError) => {
    console.error("Fatal framework blowout:", fatalError);
    process.exit(1);
});
