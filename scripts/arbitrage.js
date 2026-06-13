import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config({ override: false });

/* ================= VALIDATION & ENV ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Private Key missing from environment configurations.");

/* ================= HIGH-PERFORMANCE RPC POOL ================= */
const RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
];
let rpcIndex = 0;

/* ================= BOT CONFIGURATION ================= */
const FIXED_TRADE_SIZE = ethers.parseUnits("0.02", 6); // Global size delegated directly to the contract execution layer
const BATCH_SIZE = 3; // Number of sequential routes packed per contract call execution

/* ================= CORE CONTRACT TARGETS ================= */
const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory amounts)"];
const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch) external",
    "function usdc() view returns (address)"
];

/* ================= DEX ROUTERS MATRIX ================= */
const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= CROSS-TOKEN ROUTE MATRIX ================= */
const TOKENS = {
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
};

/* ================= RUNTIME STATE VARIABLES ================= */
let provider;
let wallet;
let vault;
let usdcContract;

function rotateNetworkProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    provider = new ethers.JsonRpcProvider(url);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
    usdcContract = new ethers.Contract(USDC, erc20Abi, provider);
}

/* ================= ATOMIC MATRIX BUILDER ================= */
function buildRawTriangularMatrix() {
    const tokens = Object.values(TOKENS);
    const routersList = Object.values(routers);
    const rawBatches = [];

    for (const router of routersList) {
        for (const tokenA of tokens) {
            for (const tokenB of tokens) {
                if (tokenA === tokenB) continue;
                rawBatches.push({
                    buyRouter: router,
                    sellRouter: router,
                    amountInUSDC: FIXED_TRADE_SIZE,
                    pathToToken: [USDC, tokenA, tokenB],
                    pathToUSDC: [tokenB, USDC]
                });
            }
        }
    }
    return rawBatches;
}

/* ================= HIGH-SPEED SIMULATE-THEN-EXECUTE ENGINE ================= */
async function sendRawBatchToContract(trades) {
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const payload = {
        buyRouters: trades.map(t => t.buyRouter),
        sellRouters: trades.map(t => t.sellRouter),
        amountsInUSDC: trades.map(t => t.amountInUSDC),
        pathsToToken: trades.map(t => t.pathToToken),
        pathsToUSDC: trades.map(t => t.pathToUSDC),
        deadline: deadline
    };

    try {
        console.log(`📡 Shipping raw batch of ${trades.length} routes directly to EVM...\n`);
        console.log(`🔍 [SIMULATION] Testing batch against exact block state...`);

        // 1. Snapshot contract balance before running execution pass
        const balanceBefore = await usdcContract.balanceOf(CONTRACT_ADDRESS);

        // 2. Off-chain profit simulation bypass via directly hitting AMM Router contracts
        let totalExpectedProfit = 0n;
        for (const trade of trades) {
            try {
                const routerContract = new ethers.Contract(trade.buyRouter, routerAbi, provider);
                
                // Route Part A: USDC -> Intermediate Tokens
                const buyAmounts = await routerContract.getAmountsOut(trade.amountInUSDC, trade.pathToToken);
                const intermediateAmount = buyAmounts[buyAmounts.length - 1];
                
                // Route Part B: Intermediate Tokens -> USDC
                const sellAmounts = await routerContract.getAmountsOut(intermediateAmount, trade.pathToUSDC);
                const finalUSDC = sellAmounts[sellAmounts.length - 1];
                
                if (finalUSDC > trade.amountInUSDC) {
                    totalExpectedProfit += (finalUSDC - trade.amountInUSDC);
                }
            } catch (err) {
                // If a target path is illiquid or fails to return amounts, skip to mimic contract behavior
                continue;
            }
        }

        // 3. Keep original contract static call sanity check for authorization and gas validation
        await vault.executeFlashBatchArbitrage.staticCall(payload);

        console.log(`🔥 SIMULATION SUCCESSFUL: Expected Batch Profit: +${ethers.formatUnits(totalExpectedProfit, 6)} USDC`);
        console.log(`📡 Shipping raw batch directly to EVM live pool...`);

        // Broadcast to live pool with optimized gas ceiling limit
        const tx = await vault.executeFlashBatchArbitrage(payload, {
            gasLimit: 450000 
        });
        console.log(`⚡ Tx Broadcasted: ${tx.hash}`);
        await tx.wait();

        // 4. Calculate realized metrics from live state completion
        const balanceAfter = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        const realProfit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;

        console.log("\n=================================================");
        console.log(`🔥 TRADES EXECUTED`);
        console.log(`   CONTRACT BEFORE BALANCE : ${ethers.formatUnits(balanceBefore, 6)} USDC`);
        console.log(`   CONTRACT AFTER BALANCE  : ${ethers.formatUnits(balanceAfter, 6)} USDC`);
        console.log(`   REALIZED PROFIT         : +${ethers.formatUnits(realProfit, 6)} USDC`);
        console.log("=================================================\n");
    } catch (error) {
        const msg = error.reason || error.shortMessage || "Batch yields below minimum threshold / Slippage hit";
        console.log(`❌ BLOCK PASS: ${msg}\n`);
    }
}

/* ================= ZERO-LATENCY HIGH-SPEED LOOP ================= */
(async function main() {
    rotateNetworkProvider();
    console.log("🏁 ZERO-REVALIDATION BOT INITIALIZED\n");
    
    const rawRoutes = buildRawTriangularMatrix();
    console.log(`📦 Compiled ${rawRoutes.length} structural market pipelines.`);
    
    while (true) {
        try {
            for (let i = 0; i < rawRoutes.length; i += BATCH_SIZE) {
                const chunk = rawRoutes.slice(i, i + BATCH_SIZE);
                await sendRawBatchToContract(chunk);
            }
        } catch (globalError) {
            rotateNetworkProvider();
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
})();
