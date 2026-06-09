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
    EURAU: "0x4933A85b5b5466Fbaf179F72D3DE273c287EC2c2",
    ORDER: "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
    IOTX: "0xf6372cdb9c1d3674e83842e3800f2a62ac9f3c66",
    AMP: "0x0621d647cecbfb64b79e44302c1933cb4f27054d",
    CBK: "0x4EC203dD0699Fac6adAF483CDd2519BC05D2c573",
    ACX: "0xf328b73b6c685831f238c30a23fc19140cb4d8fc",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
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
