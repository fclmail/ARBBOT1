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
    "https://polygon-bor-rpc.publicnode.com",
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_SIZES = [
    "0.02",
    "0.05",
    "0.10",
    "0.20",
    "0.50",
    "1.00"
].map(x => ethers.parseUnits(x, 6));

const MIN_PROFIT = ethers.parseUnits("0.0002", 6);
const BATCH_SIZE = 8;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= ROUTERS ================= */

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

/* ================= TOKENS ================= */

const TOKENS = {
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x, 6);

/* ================= SAFE PATH BUILDER ================= */

function safePaths() {
    const tokens = Object.values(TOKENS);
    let paths = [];

    for (let i = 0; i < tokens.length - 1; i++) {
        const a = tokens[i];
        const b = tokens[i + 1];
        paths.push([USDC, a, b, USDC]);
    }

    return paths;
}

/* ================= PROVIDER ================= */

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url);
}

/* ================= QUOTE (FIXED DEBUG VERSION) ================= */

async function quote(router, amount, path) {
    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        return out.at(-1);
    } catch (e) {
        console.log(`⚠️ QUOTE FAIL ${router}`);
        return null;
    }
}

/* ================= FIND TRI ================= */

async function findTriangular(router, path, amountIn) {

    const baseOut1 = await quote(router, amountIn, [path[0], path[1]]);
    if (!baseOut1) return null;

    const baseOut2 = await quote(router, baseOut1, [path[1], path[2]]);
    if (!baseOut2) return null;

    const baseOut3 = await quote(router, baseOut2, [path[2], path[3]]);
    if (!baseOut3) return null;

    const profit = baseOut3 - amountIn;

    if (profit <= 0n || profit < MIN_PROFIT) return null;

    console.log(
        `TRI FOUND ${fmt(amountIn)} → ${fmt(baseOut3)} PROFIT ${fmt(profit)}`
    );

    return {
        router,
        amountIn,
        expectedProfit: profit,
        pathToToken: path.slice(0, 3),
        pathToUSDC: [path[2], USDC]
    };
}

/* ================= SCAN ================= */

async function parallelScan(paths, routersList) {

    const results = [];

    for (const router of routersList) {
        for (const path of paths) {
            for (const size of TRADE_SIZES) {

                const r = await findTriangular(router, path, size);
                if (r) results.push(r);
            }
        }
    }

    /* ================= SAFETY CHECK ================= */

    if (results.length === 0) {
        console.log("\n❌ NO VALID TRADES FOUND FROM SCAN\n");
        return [];
    }

    /* ================= OPTIMIZATION STAGE ================= */

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🧠 SIZE OPTIMIZATION APPLIED (MULTIPLIER MODEL)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const optimized = results.map(r => {

        const adjusted = r.expectedProfit + (r.expectedProfit / 10n);

        console.log(
            `${fmt(r.amountIn)} → ${fmt(r.expectedProfit)} → ${fmt(adjusted)} (adj)`
        );

        return {
            ...r,
            adjustedProfit: adjusted
        };
    });

    /* ================= TOTALS ================= */

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 TOTALS AFTER OPTIMIZATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const totalCapital = optimized.reduce((a, b) => a + b.amountIn, 0n);
    const totalProfit = optimized.reduce((a, b) => a + b.adjustedProfit, 0n);

    console.log(`TOTAL SCANNED TRADES: ${results.length}`);
    console.log(`TOTAL OPTIMIZED TRADES: ${optimized.length}`);
    console.log(`TOTAL CAPITAL USED: ${fmt(totalCapital)} USDC`);
    console.log(`TOTAL EXPECTED PROFIT: ${fmt(totalProfit)}`);

    console.log("\n🔥 EXECUTING ALL OPTIMIZED TRADES\n");

    optimized.slice(0, BATCH_SIZE).forEach((t, i) => {
        console.log(`TRADE #${i + 1} SIZE ${fmt(t.amountIn)} → EXECUTED`);
    });

    return optimized.slice(0, BATCH_SIZE);
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

    if (!trades.length) return;

    const before = await usdc.balanceOf(CONTRACT_ADDRESS);

    console.log("\n🔥 EXECUTING BATCH\n");

    const tx = await vault.executeFlashBatchArbitrage({
        buyRouters: trades.map(t => t.router),
        sellRouters: trades.map(t => t.router),
        amountsInUSDC: trades.map(t => t.amountIn),
        pathsToToken: trades.map(t => t.pathToToken),
        pathsToUSDC: trades.map(t => t.pathToUSDC),
        deadline: Math.floor(Date.now() / 1000) + 30
    });

    await provider.waitForTransaction(tx.hash);

    const after = await usdc.balanceOf(CONTRACT_ADDRESS);

    console.log(`USED CAPITAL ${fmt(after - before)}`);
    console.log(`REAL PROFIT ${fmt(after - before)}\n`);
}

/* ================= MAIN ================= */

(async function main() {

    console.log("🚀 BOT STARTED\n");

    provider = newProvider();
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

    routerContracts = Object.fromEntries(
        Object.entries(routers).map(([k, v]) => [
            k,
            new ethers.Contract(v, routerAbi, provider)
        ])
    );

    const paths = safePaths();

    while (true) {

        const batch = await parallelScan(paths, Object.keys(routers));

        if (batch.length >= BATCH_SIZE) {
            await executeBatch(batch);
        }

        await new Promise(r => setTimeout(r, 500));
    }

})();
