import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* =========================================================================
   LIVE BLOCKCHAIN PROVIDER & CONFIGURATION
   ========================================================================= */
const PROVIDER_URL = "https://polygon-bor-rpc.publicnode.com";
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

// Native Production Base Asset (Verify this matches your deployed contract constructor!)
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; 

// Expanded Multi-Route Asset Token Matrix
const TOKENS = {
    WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",   // Wrapped POL (replaces legacy WMATIC)
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",  // Deeply liquid stable route alternate
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error("ðŸ›‘ CONFIG ERROR: WALLET_PRIVATE_KEY is missing from environment.");
    process.exit(1);
}

// Terminal ANSI Formatting Controllers
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

/* =========================================================================
   APPLICATION STRUCT ABIS
   ========================================================================= */
const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)"
];

const VAULT_ABI = [
    "function minimumProfitUSDC() external view returns (uint256)",
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC) external view returns ((uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit) best)",
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external"
];

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

const fmt = x => ethers.formatUnits(x, 6);

/* =========================================================================
   CORE PIPELINE ENGINE
   ========================================================================= */
class PureVaultArbEngine {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(PROVIDER_URL, undefined, { staticNetwork: true });
        this.wallet = new ethers.Wallet(PRIVATE_KEY, this.provider);
        this.vaultContract = new ethers.Contract(CONTRACT_ADDRESS, VAULT_ABI, this.wallet);
        this.usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, this.provider);
        
        this.isExecuting = false;
        this.routerList = Object.values(routers);
        this.tokenList = Object.values(TOKENS);
    }

    // Guarantees solid testing candidates regardless of raw wallet funding status
    generateCandidateSizes(vaultBalance) {
        const step = vaultBalance / 5n;
        
        if (step === 0n) {
            return [
                20000n,  // 0.02 USDC debugging size
                50000n,  // 0.05 USDC debugging size
                100000n  // 0.10 USDC debugging size
            ];
        }
        
        return [step, step * 2n, step * 3n, step * 4n, vaultBalance];
    }

    async start() {
        console.log(`${CYAN}ðŸš€ DIAGNOSTIC VAULT ENGINE ONLINE${RESET}`);
        console.log(`ðŸ“¡ Targeting Contract Enforcer: ${CONTRACT_ADDRESS}`);
        console.log(`ðŸ’Ž Tracking Pairs: Native USDC + [WPOL, WETH, USDT, WBTC]`);

        const manualTestProfitTarget = ethers.parseUnits("0.000001", 6);
        console.log(`ðŸ“Š Pipeline Minimum Profit Trigger: ${fmt(manualTestProfitTarget)} USDC\n`);

        this.provider.on("block", async (blockNumber) => {
            console.log(`\n--- [BLOCK ${blockNumber}] Scanning Cross-Protocol Liquidity Matrix ---`);
            if (this.isExecuting) return;

            try {
                await this.scanBlockChannels(manualTestProfitTarget);
            } catch (err) {
                console.error("âš ï¸ System Loop Warning:", err.message);
            }
        });
    }

    async scanBlockChannels(profitTargetThreshold) {
        const vaultBalance = await this.usdcContract.balanceOf(CONTRACT_ADDRESS);
        const candidateSizes = this.generateCandidateSizes(vaultBalance);

        const profitableTradesFound = [];

        for (const buyR of this.routerList) {
            for (const sellR of this.routerList) {
                if (buyR === sellR) continue;

                for (const token of this.tokenList) {
                    try {
                        const path1 = [USDC_ADDRESS, token];
                        const path2 = [token, USDC_ADDRESS];

                        // Query the solver contract to read AMM pool dynamics
                        const bestResult = await this.vaultContract.findBestFlashLoanSize(
                            buyR,
                            sellR,
                            candidateSizes,
                            path1,
                            path2
                        );

                        // LIVE DIAGNOSTIC OUTPUT
                        // Prints the exact math the smart contract is extracting back from the DEX routers
                        const buyName = Object.keys(routers).find(k => routers[k] === buyR);
                        const sellName = Object.keys(routers).find(k => routers[k] === sellR);
                        const tokenName = Object.keys(TOKENS).find(k => TOKENS[k] === token);
                        
                        console.log(`${DIM}ðŸ” [POOL CHECK] ${buyName} âž” ${sellName} via ${tokenName} | Best Size: ${fmt(bestResult.amountIn)} USDC | Est Profit: ${fmt(bestResult.estimatedProfit)} USDC${RESET}`);

                        if (bestResult.estimatedProfit >= profitTargetThreshold) {
                            console.log(`${GREEN}ðŸŽ¯ PROFIT TARGET GAP LOCATED!${RESET}`);
                            console.log(`${GREEN}   Routers: ${buyR} (${buyName}) âž” ${sellR} (${sellName})${RESET}`);
                            console.log(`${GREEN}   Token Leg: USDC âž” ${tokenName} âž” USDC${RESET}`);
                            console.log(`${GREEN}   Optimized Input Size: ${fmt(bestResult.amountIn)} USDC${RESET}`);
                            console.log(`${GREEN}   Net Return Yielded:  +${fmt(bestResult.estimatedProfit)} USDC${RESET}\n`);

                            profitableTradesFound.push({
                                buyRouter: buyR,
                                sellRouter: sellR,
                                amountIn: bestResult.amountIn,
                                pathToToken: path1,
                                pathToUSDC: path2
                            });

                            if (profitableTradesFound.length >= 3) break;
                        }
                    } catch (e) {
                        // Suppress failures from broken routing legs, but display an activity marker
                        continue;
                    }
                }
                if (profitableTradesFound.length >= 3) break;
            }
            if (profitableTradesFound.length >= 3) break;
        }

        if (profitableTradesFound.length > 0) {
            await this.executeVaultBatch(profitableTradesFound);
        }
    }

    async executeVaultBatch(trades) {
        try {
            this.isExecuting = true;
            console.log(`${YELLOW}ðŸ”¥ Packaging Batch Parameters for Contract Execution...${RESET}`);

            const batchStruct = {
                buyRouters: trades.map(t => t.buyRouter),
                sellRouters: trades.map(t => t.sellRouter),
                amountsInUSDC: trades.map(t => t.amountIn),
                pathsToToken: trades.map(t => t.pathToToken),
                pathsToUSDC: trades.map(t => t.pathToUSDC),
                deadline: Math.floor(Date.now() / 1000) + 60
            };

            const feeData = await this.provider.getFeeData();
            
            const tx = await this.vaultContract.executeFlashBatchArbitrage(batchStruct, {
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                gasLimit: 600000 
            });

            console.log(`âœ‰ï¸ Batch Transaction Broadcasted. Hash: ${tx.hash}`);
            await this.provider.waitForTransaction(tx.hash);
            console.log(`${GREEN}âœ… BATCH TRANSACTION MINED SUCCESSFULLY BY NETWORK${RESET}\n`);

        } catch (err) {
            console.error("ðŸ›‘ On-Chain Execution Reverted:", err.message);
        } finally {
            this.isExecuting = false;
        }
    }
}

const engine = new PureVaultArbEngine();
engine.start();
