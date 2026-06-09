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
        const step = vaultBalance / 1n;
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
