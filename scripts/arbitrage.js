import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV & CONFIG ================= */
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PK missing");

const RPCS = ["https://polygon-bor-rpc.publicnode.com"];
let rpcIndex = 0;
let provider, wallet, usdc, vault, routerContracts;

const BATCH_SIZE = 3;
const BASE_TRADE = ethers.parseUnits("10", 6); // Set appropriate test trade amount (e.g., 10 USDC)
const MIN_PROFIT = ethers.parseUnits("0.001", 6);
const GAS_COST_USDC = ethers.parseUnits("0.0005", 6);

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
    "function executeBalancerFlashLoanArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] pathToToken, address[] pathToUSDC, uint256 deadline)",
    "function preApproveCoreAssets(address router)",
    "function withdraw(uint256)"
];

const routerAbi = [
    "function getAmountsOut(uint amountIn, address[] path) view returns(uint[] amounts)"
];

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

const fmt = x => ethers.formatUnits(x, 6);
const quoteCache = new Map();

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
    provider = newProvider();
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
    routerContracts = Object.fromEntries(
        Object.entries(routers).map(([name, addr]) => [addr, new ethers.Contract(addr, routerAbi, provider)])
    );
}

async function quote(routerAddr, amount, path) {
    const key = `${routerAddr}-${path.join('-')}-${amount.toString()}`;
    if (quoteCache.has(key)) return quoteCache.get(key);
    try {
        const amounts = await routerContracts[routerAddr].getAmountsOut(amount, path);
        const result = amounts[amounts.length - 1];
        quoteCache.set(key, result);
        return result;
    } catch {
        quoteCache.set(key, null);
        return null;
    }
}

/* ================= PATH & ARBITRAGE FINDER ================= */

async function evaluateCrossDexOpportunity(buyRouter, sellRouter, tokenAddress) {
    if (buyRouter === sellRouter) return null;

    // Standard 2-hop route structure required by contract
    const pathToToken = [USDC, tokenAddress];
    const pathToUSDC = [tokenAddress, USDC];

    // Leg 1: Buy Intermediate Token on Buy Router
    const expectedTokenOut = await quote(buyRouter, BASE_TRADE, pathToToken);
    if (!expectedTokenOut || expectedTokenOut === 0n) return null;

    // Leg 2: Sell Intermediate Token back to USDC on Sell Router
    const expectedUsdcBack = await quote(sellRouter, expectedTokenOut, pathToUSDC);
    if (!expectedUsdcBack || expectedUsdcBack === 0n) return null;

    const profit = expectedUsdcBack > BASE_TRADE ? expectedUsdcBack - BASE_TRADE : 0n;
    if (profit < MIN_PROFIT) return null;

    return {
        buyRouter,
        sellRouter,
        amountIn: BASE_TRADE,
        pathToToken,
        pathToUSDC,
        expectedProfit: profit
    };
}

async function scanMarket() {
    const routerAddresses = Object.values(routers);
    const tokenAddresses = Object.values(TOKENS);
    const scanPromises = [];

    for (const buyRouter of routerAddresses) {
        for (const sellRouter of routerAddresses) {
            if (buyRouter === sellRouter) continue;
            for (const token of tokenAddresses) {
                scanPromises.push(evaluateCrossDexOpportunity(buyRouter, sellRouter, token));
            }
        }
    }

    const results = await Promise.all(scanPromises);
    const validTrades = results.filter(r => r !== null);
    validTrades.sort((a, b) => (b.expectedProfit > a.expectedProfit ? 1 : -1));
    return validTrades.slice(0, BATCH_SIZE);
}

/* ================= BATCH EXECUTION ================= */

async function executeBatch(trades) {
    console.log(`\n🔥 EXECUTING BATCH OF ${trades.length} TRADES`);
    try {
        const totalExpected = trades.reduce((acc, t) => acc + t.expectedProfit, 0n);
        if (totalExpected < GAS_COST_USDC) {
            console.log("❌ SKIPPED: EXPECTED PROFIT BELOW ESTIMATED GAS");
            return;
        }

        const balanceBefore = await usdc.balanceOf(CONTRACT_ADDRESS);

        const batchParam = {
            buyRouters: trades.map(t => t.buyRouter),
            sellRouters: trades.map(t => t.sellRouter),
            amountsInUSDC: trades.map(t => t.amountIn),
            pathsToToken: trades.map(t => t.pathToToken),
            pathsToUSDC: trades.map(t => t.pathToUSDC),
            deadline: Math.floor(Date.now() / 1000) + 60
        };

        const tx = await vault.executeFlashBatchArbitrage(batchParam, { gasLimit: 1200000 });
        console.log(`Tx submitted: ${tx.hash}`);
        await tx.wait();

        const balanceAfter = await usdc.balanceOf(CONTRACT_ADDRESS);
        const realProfit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
        console.log(`✅ REAL ACCUMULATED PROFIT DEPOSITED: ${fmt(realProfit)} USDC`);
    } catch (err) {
        console.error("⚠️ BATCH EXECUTION REVERTED:", err.reason || err.message);
    }
}

/* ================= MAIN ENGINE ================= */

(async function main() {
    console.log("🚀 ARBITRAGE BOT STARTED");
    rebuildContracts();

    let lastBlock = 0;

    while (true) {
        try {
            const currentBlock = await provider.getBlockNumber();
            if (currentBlock > lastBlock) {
                lastBlock = currentBlock;
                quoteCache.clear();
            }

            const trades = await scanMarket();
            if (trades.length > 0) {
                await executeBatch(trades);
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            console.error("❌ Loop Error:", error.message);
            rebuildContracts();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
})();
