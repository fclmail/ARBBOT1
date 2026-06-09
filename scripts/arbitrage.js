import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* =========================================================================
   LIVE BLOCKCHAIN PROVIDER & CONFIGURATION
   ========================================================================= */
const PROVIDER_URL = "https://polygon-bor-rpc.publicnode.com";
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error("ðŸ›‘ CONFIG ERROR: PRIVATE_KEY is missing.");
    process.exit(1);
}

// ANSI Escape Codes for Terminal Colorization
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

/* =========================================================================
   CONTRACT ABIS (Directly matching your VaultArbitrageEnforcer)
   ========================================================================= */
const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)"
];

const VAULT_ABI = [
    "function minimumProfitUSDC() external view returns (uint256)",
    "function findBestFlashLoanSize(address buyRouter, address sellRouter, uint256[] calldata candidateSizes, address[] calldata pathToToken, address[] calldata pathToUSDC) external view returns ((uint256 amountIn, uint256 estimatedFinalUSDC, uint256 estimatedProfit) best)",
    "function executeFlashBatchArbitrage((address[] buyRouters, address[] sellRouters, uint256[] amountsInUSDC, address[][] pathsToToken, address[][] pathsToUSDC, uint256 deadline) batch) external"
];

/* --- HARDWARE ROUTER MATRICES --- */
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const fmt = x => ethers.formatUnits(x, 6);

/* =========================================================================
   CORE ARBITRAGE SCANNING ENGINE
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

    // Generates test sizes inside vault budget limits
    generateCandidateSizes(vaultBalance) {
        const step = vaultBalance / 5n;
        if (step === 0n) return [];
        
        // Simulates 5 scaling steps up to the absolute max vault liquidity
        return [step, step * 2n, step * 3n, step * 4n, vaultBalance];
    }

    async start() {
        const minProfitTarget = await this.vaultContract.minimumProfitUSDC();
        console.log(`${CYAN}ðŸš€ PURE VAULT FUND BOT INITIALIZED${RESET}`);
        console.log(`ðŸ“¡ Targeting Contract Enforcer: ${CONTRACT_ADDRESS}`);
        console.blockProfit = fmt(minProfitTarget);
        console.log(`ðŸ“Š Contract Minimum Profit Target Enforced: ${console.blockProfit} USDC\n`);

        this.provider.on("block", async (blockNumber) => {
            console.log(`--- [BLOCK ${blockNumber}] Reading On-Chain Depth Matrices ---`);
            if (this.isExecuting) return;

            try {
                await this.scanBlockChannels(minProfitTarget);
            } catch (err) {
                console.error("âš ï¸ Pipeline Error:", err.message);
            }
        });
    }

    async scanBlockChannels(minProfitTarget) {
        const vaultBalance = await this.usdcContract.balanceOf(CONTRACT_ADDRESS);
        if (vaultBalance === 0n) {
            console.log(`${YELLOW}âš ï¸ Scanner Idle: Vault contract has 0 USDC balance.${RESET}`);
            return;
        }

        const candidateSizes = this.generateCandidateSizes(vaultBalance);
        const profitableTradesFound = [];

        // Scan every Cross-DEX iteration loop combo
        for (const buyR of this.routerList) {
            for (const sellR of this.routerList) {
                if (buyR === sellR) continue;

                for (const token of this.tokenList) {
                    try {
                        const path1 = [USDC_ADDRESS, token];
                        const path2 = [token, USDC_ADDRESS];

                        // Call the smart contract view function to find the absolute optimized trade size
                        const bestResult = await this.vaultContract.findBestFlashLoanSize(
                            buyR,
                            sellR,
                            candidateSizes,
                            path1,
                            path2
                        );

                        if (bestResult.estimatedProfit >= minProfitTarget) {
                            console.log(`${GREEN}ðŸŽ¯ PROFIT TARGET GAP LOCATED!${RESET}`);
                            console.log(`${GREEN}   Routers: ${buyR} âž” ${sellR}${RESET}`);
                            console.log(`${GREEN}   Token Leg: USDC âž” ${token} âž” USDC${RESET}`);
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
                    } catch {
                        continue; // Skip faulty pools silently
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
            
            // Fire directly into the vault-funds batch mechanism
            const tx = await this.vaultContract.executeFlashBatchArbitrage(batchStruct, {
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                gasLimit: 600000 // Multi-trade vault swaps consume significantly less gas than flash loans
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

// Start Engine
const engine = new PureVaultArbEngine();
engine.start();
