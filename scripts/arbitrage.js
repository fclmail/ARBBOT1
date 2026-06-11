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

// FIX 1: LOWER SAFE THRESHOLD
const MIN_PROFIT = ethers.parseUnits("0.00005", 6);

const BATCH_SIZE = 4;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
    "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const USDC =
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABIs ================= */

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

/* ================= DYNAMIC BASE TRADE (NEW FIX) ================= */

function adaptiveBaseTrade(routerIndex) {
    // Small variation per router to avoid dead zones
    const multipliers = [1n, 2n, 3n];

    return (BASE_TRADE * multipliers[routerIndex % 3]) / 1n;
}

/* ================= SLIPPAGE SAFETY (LIGHT FIX) ================= */

function adjustProfit(out, inAmount) {
    // subtract tiny buffer (0.05%) to avoid overestimation
    return out - (inAmount * 5n / 10000n);
}

/* ================= PROVIDER ================= */

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;

    console.log("🔄 RPC SWITCH:", url);

    return new ethers.JsonRpcProvider(url);
}

/* ================= INIT ================= */

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

    routerContracts = Object.fromEntries(
        Object.entries(routers).map(([k, v]) => [
            k,
            new ethers.Contract(v, routerAbi, provider)
        ])
    );

    console.log("✅ CONTRACTS INITIALIZED");
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
    try {
        const out =
            await routerContracts[router].getAmountsOut(amount, path);

        return out.at(-1);

    } catch {
        return null;
    }
}

/* ================= PATHS ================= */

function buildPaths() {
    const tokens = Object.values(routers);
    const paths = [];

    for (let i = 0; i < tokens.length; i++) {
        for (let j = 0; j < tokens.length; j++) {
            if (i === j) continue;
            paths.push([USDC, tokens[i], tokens[j], USDC]);
        }
    }

    console.log("📦 PATHS GENERATED:", paths.length);

    return paths;
}

/* ================= TRI FINDER ================= */

async function findTriangular(router, path, routerIndex = 0) {

    const baseTrade =
        adaptiveBaseTrade(routerIndex);

    const out1 =
        await quote(router, baseTrade, [path[0], path[1]]);
    if (!out1) return null;

    const out2 =
        await quote(router, out1, [path[1], path[2]]);
    if (!out2) return null;

    const out3 =
        await quote(router, out2, [path[2], path[3]]);
    if (!out3) return null;

    // FIX 3: SLIPPAGE-ADJUSTED PROFIT
    const adjustedOut =
        adjustProfit(out3, baseTrade);

    const profit =
        adjustedOut - baseTrade;

    if (profit < MIN_PROFIT) return null;

    console.log(
        `TRI FOUND ${ethers.formatUnits(baseTrade,6)} → ${ethers.formatUnits(out3,6)} PROFIT ${ethers.formatUnits(profit,6)}`
    );

    return {
        router,
        amountIn: baseTrade,
        pathToToken: path.slice(0,3),
        pathToUSDC: [path[2], USDC],
        expectedProfit: profit
    };
}

/* ================= SCAN ================= */

async function scan(paths) {

    const results = [];

    let routerIndex = 0;

    for (const router of Object.keys(routers)) {

        for (const path of paths.slice(0, 25)) {

            const r =
                await findTriangular(router, path, routerIndex);

            if (r) results.push(r);

            if (results.length >= BATCH_SIZE) {
                return results;
            }
        }

        routerIndex++;
    }

    return results;
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

    console.log("\n🔥 EXECUTING BATCH\n");

    const before = await usdc.balanceOf(CONTRACT_ADDRESS);

    let total = 0n;
    let expected = 0n;

    for (const t of trades) {
        total += t.amountIn;
        expected += t.expectedProfit;
    }

    console.log(`USED CAPITAL ${ethers.formatUnits(total,6)}`);
    console.log(`EXPECTED PROFIT ${ethers.formatUnits(expected,6)}\n`);

    const tx =
        await vault.executeFlashBatchArbitrage({
            buyRouters: trades.map(t => t.router),
            sellRouters: trades.map(t => t.router),
            amountsInUSDC: trades.map(t => t.amountIn),
            pathsToToken: trades.map(t => t.pathToToken),
            pathsToUSDC: trades.map(t => t.pathToUSDC),
            deadline: Math.floor(Date.now()/1000)+30
        });

    await provider.waitForTransaction(tx.hash);

    const after = await usdc.balanceOf(CONTRACT_ADDRESS);

    console.log(`CONTRACT BEFORE ${ethers.formatUnits(before,6)}`);
    console.log(`CONTRACT AFTER  ${ethers.formatUnits(after,6)}`);

    const real =
        after > before ? after - before : 0n;

    console.log(`REAL PROFIT ${ethers.formatUnits(real,6)}\n`);
}

/* ================= MAIN ================= */

(async function main() {

    console.log("🚀 BOT STARTED");

    provider = newProvider();
    rebuildContracts();

    const paths = buildPaths();

    while (true) {

        try {

            const trades =
                await scan(paths);

            if (trades.length) {
                await executeBatch(trades);
            }

            await new Promise(r => setTimeout(r, 300));

        } catch (e) {

            console.log("ERROR:", e.message);

            provider = newProvider();
            rebuildContracts();

        }

    }

})();
