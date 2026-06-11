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
const MIN_PROFIT = ethers.parseUnits("0.0002", 6);
const GAS_COST_USDC = ethers.parseUnits("0.00003", 6);
const BATCH_SIZE = 4;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
    "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const USDC =
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
    "function withdraw(uint256)"
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

/* ================= CACHE ================= */

const liquidityCache = new Map();
const quoteCache = new Map();

function cacheGet(map, key, ttl = 2000) {
    const v = map.get(key);
    if (!v) return null;
    if (Date.now() - v.t > ttl) return null;
    return v.v;
}

function cacheSet(map, key, value) {
    map.set(key, { v: value, t: Date.now() });
}

/* ================= PROVIDER ================= */

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url);
}

/* ================= CONTRACT INIT ================= */

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
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
    const key = `${router}-${path.join("-")}-${amount}`;
    const cached = cacheGet(quoteCache, key);
    if (cached) return cached;

    try {
        const out =
            await routerContracts[router].getAmountsOut(amount, path);

        const res = out.at(-1);

        cacheSet(quoteCache, key, res);

        return res;

    } catch {
        return null;
    }
}

/* ================= LIQUIDITY ================= */

async function getLiquidity(router, tokenA, tokenB) {
    const key = `${router}-${tokenA}-${tokenB}`;
    const cached = cacheGet(liquidityCache, key, 2000);
    if (cached) return cached;

    try {
        const factory = new ethers.Contract(
            await routerContracts[router].factory(),
            ["function getPair(address,address) view returns(address)"],
            provider
        );

        const pairAddr =
            await factory.getPair(tokenA, tokenB);

        if (pairAddr === ethers.ZeroAddress) return 0n;

        const pair = new ethers.Contract(
            pairAddr,
            [
                "function getReserves() view returns(uint112,uint112,uint32)",
                "function token0() view returns(address)"
            ],
            provider
        );

        const reserves = await pair.getReserves();
        const token0 = await pair.token0();

        const liquidity =
            token0.toLowerCase() === tokenA.toLowerCase()
                ? BigInt(reserves[0])
                : BigInt(reserves[1]);

        cacheSet(liquidityCache, key, liquidity);

        return liquidity;

    } catch {
        return 0n;
    }
}

/* ================= SIZE GENERATOR ================= */

function generateSizes(liquidity) {
    const p = [
        1000000n,
        500000n,
        100000n,
        50000n,
        10000n,
        5000n,
        1000n
    ];

    return p
        .map(x => liquidity / x)
        .filter(x => x > 0n);
}

/* ================= TRI FINDER ================= */

async function findTriangular(router, path) {

    const liquidity =
        await getLiquidity(router, USDC, path[1]);

    if (!liquidity) return null;

    const sizes = generateSizes(liquidity);

    let bestAmount = 0n;
    let bestProfit = 0n;
    let bestOut = 0n;

    for (const amount of sizes) {

        const out1 =
            await quote(router, amount, [path[0], path[1]]);
        if (!out1) continue;

        const out2 =
            await quote(router, out1, [path[1], path[2]]);
        if (!out2) continue;

        const out3 =
            await quote(router, out2, [path[2], path[3]]);
        if (!out3) continue;

        const profit = out3 - amount;

        if (profit > bestProfit) {
            bestProfit = profit;
            bestAmount = amount;
            bestOut = out3;
        }
    }

    if (bestProfit < MIN_PROFIT) return null;

    console.log(
        `TRI FOUND ${ethers.formatUnits(bestAmount,6)} → ${ethers.formatUnits(bestOut,6)} PROFIT ${ethers.formatUnits(bestProfit,6)}`
    );

    return {
        router,
        amountIn: bestAmount,
        pathToToken: path.slice(0, 3),
        pathToUSDC: [path[2], USDC],
        expectedProfit: bestProfit
    };
}

/* ================= PARALLEL SCAN ================= */

async function parallelScan(paths, routersList) {
    const results = [];

    for (const router of routersList) {
        for (const path of paths.slice(0, BATCH_SIZE * 10)) {

            const r = await findTriangular(router, path).catch(() => null);
            if (r) results.push(r);

            if (results.length >= BATCH_SIZE) break;
        }
    }

    return results.slice(0, BATCH_SIZE);
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

    const tx = await vault.executeFlashBatchArbitrage({
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

    const real = after > before ? after - before : 0n;

    console.log(`\nREAL PROFIT     ${ethers.formatUnits(real,6)}\n`);
}

/* ================= MAIN ================= */

(async function main() {

    console.log("🚀 BOT STARTED\n");

    provider = newProvider();
    rebuildContracts();

    const paths = [];

    const tokens = Object.values(routers);

    for (let i = 0; i < tokens.length; i++) {
        for (let j = 0; j < tokens.length; j++) {
            if (i === j) continue;
            paths.push([USDC, tokens[i], tokens[j], USDC]);
        }
    }

    while (true) {

        try {

            const trades =
                await parallelScan(paths, Object.keys(routers));

            if (trades.length) {
                await executeBatch(trades);
            }

        } catch (e) {

            console.log("ERROR:", e.message);

            provider = newProvider();
            rebuildContracts();

        }

    }

})();
