import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
    "https://polygon-bor-rpc.publicnode.com"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const BASE_TRADE = ethers.parseUnits("0.02", 6);
const MIN_PROFIT = ethers.parseUnits("0.00005", 6);
const BATCH_SIZE = 100;
const TARGET_BATCH_QUANTITY = 3;
const SCAN_INTERVAL_MS = 2000;
const MAX_FAILURES = 10;

let consecutiveFailures = 0;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
    "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const USDC =
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ROUTERS ================= */

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= TOKENS ================= */

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
    UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    BAT: "0x3cef98bb43d732e2f285ee605a8158cde967d219",
    TBTC: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
    MANA: "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
};

/* ================= FIXES ADDED ================= */

function newProvider() {
    const rpc = RPCS[rpcIndex % RPCS.length];
    rpcIndex++;
    return new ethers.JsonRpcProvider(rpc);
}

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    usdc = new ethers.Contract(
        USDC,
        ["function balanceOf(address) view returns (uint256)"],
        wallet
    );

    vault = new ethers.Contract(
        CONTRACT_ADDRESS,
        [],
        wallet
    );
}

function buildTriangularPaths() {
    const tokens = Object.values(TOKENS);
    const paths = [];

    for (let i = 0; i < tokens.length; i++) {
        for (let j = 0; j < tokens.length; j++) {
            for (let k = 0; k < tokens.length; k++) {
                if (i === j || j === k || i === k) continue;

                paths.push({
                    pathToToken: [tokens[i], tokens[j]],
                    pathToUSDC: [tokens[j], tokens[k]]
                });
            }
        }
    }

    return paths;
}

/* ================= CHECK OPPORTUNITY ================= */

async function checkOpportunity(pathData) {
    try {
        const gasCostInUSDC = gasCost / BigInt(1000000);
        const netProfit = profit - gasCostInUSDC;

        if (netProfit > MIN_PROFIT) {
            return {
                pathData,
                profit: netProfit,
                usdcReturn,
                tokenAmount
            };
        }

        return null;
    } catch (error) {
        return null;
    }
}

/* ================= BATCH SCANNER ================= */

async function scanBatchForOpportunities(batchPaths) {
    const opportunities = [];

    const promises = batchPaths.map(pathData =>
        checkOpportunity(pathData)
            .then(result => {
                if (result) {
                    opportunities.push(result);
                    console.log(`🎯 Found opportunity: ${ethers.formatUnits(result.profit, 6)} USDC profit`);
                }
            })
            .catch(() => {})
    );

    await Promise.all(promises);
    return opportunities;
}

/* ================= BATCH EXECUTION ================= */

async function processBatch(paths, batchIndex) {
    const start = batchIndex * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, paths.length);
    const batch = paths.slice(start, end);

    console.log(`\n📦 Scanning batch ${batchIndex + 1}`);

    const opportunities = await scanBatchForOpportunities(batch);

    if (opportunities.length >= TARGET_BATCH_QUANTITY) {
        return opportunities;
    }

    return null;
}

/* ================= EXECUTE TRADE ================= */

async function executeTrade(opportunity) {
    const { pathData, profit } = opportunity;
    const { pathToToken, pathToUSDC } = pathData;

    try {
        console.log(`💎 EXECUTING TRADE`);

        const tx = await vault.executeFlashBatchArbitrage({
            buyRouters: [Object.values(routers)[0]],
            sellRouters: [Object.values(routers)[0]],
            amountsInUSDC: [BASE_TRADE],
            pathsToToken: [pathToToken],
            pathsToUSDC: [pathToUSDC],
            deadline: Math.floor(Date.now() / 1000) + 60
        });

        const receipt = await tx.wait();

        if (receipt.status === 1) {
            console.log("✅ SUCCESS");
            return true;
        }

        return false;
    } catch (error) {
        console.log(`⚠️ ${error.message}`);
        return false;
    }
}

/* ================= LOOP ================= */

async function continuousArbitrageLoop(paths) {
    while (true) {
        try {
            if (consecutiveFailures >= MAX_FAILURES) break;

            provider = newProvider();
            rebuildContracts();

            const totalBatches = Math.ceil(paths.length / BATCH_SIZE);
            let all = [];

            for (let i = 0; i < totalBatches; i++) {
                const res = await processBatch(paths, i);
                if (res) all.push(...res);
            }

            if (all.length >= TARGET_BATCH_QUANTITY) {
                all.sort((a, b) => b.profit - a.profit);
                await executeTrade(all[0]);
            }

            await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));

        } catch (e) {
            consecutiveFailures++;
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

/* ================= MAIN ================= */

(async function main() {
    console.log("🚀 ARBITRAGE BOT STARTED");

    provider = newProvider();
    rebuildContracts();

    const walletAddress = wallet.address;
    console.log(`🏦 Wallet: ${walletAddress}`);

    const paths = buildTriangularPaths();

    console.log(`🧭 Paths: ${paths.length}`);

    await continuousArbitrageLoop(paths);

})().catch(error => {
    console.error("💀 FATAL ERROR:", error);
    process.exit(1);
});
