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

const BASE_TRADE = ethers.parseUnits("0.01", 6);
const MIN_PROFIT = ethers.parseUnits("0.000002", 6);
const GAS_COST_USDC = ethers.parseUnits("0.000001", 6);
const BATCH_SIZE = 4;

/* ================= GLOBAL STATE ================= */

let triangularPaths = [];
let tradeBuffer = [];
let scanning = true;

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
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    Ww: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
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
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
};

/* ================= ABI ================= */

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)"
];

const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

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

/* ================= PATH GENERATION ================= */

function buildGraph() {
    const graph = {};
    const tokens = Object.values(TOKENS);

    graph[USDC] = tokens;

    for (const t of tokens) {
        graph[t] = [...tokens, USDC].filter(x => x !== t);
    }

    return graph;
}

function dfsPaths(graph, start, depth) {
    const results = [];

    function dfs(path, d) {
        const last = path[path.length - 1];

        if (d === 0) {
            results.push([...path, USDC]);
            return;
        }

        for (const next of graph[last]) {
            if (path.includes(next)) continue;
            dfs([...path, next], d - 1);
        }
    }

    dfs([start], depth);

    return results;
}

function buildTriangularPaths() {
    const graph = buildGraph();

    let paths = [];

    paths.push(...dfsPaths(graph, USDC, 2));
    paths.push(...dfsPaths(graph, USDC, 3));
    paths.push(...dfsPaths(graph, USDC, 4));

    console.log("📦 PATHS GENERATED:", paths.length);

    return paths.map(p => ({
        path: p,
        pathToToken: p.slice(0, -2),
        pathToUSDC: [p[p.length - 2], USDC]
    }));
}

/* ================= SCANNER ================= */

async function scanLoop() {
    console.log("🔎 SCANNER STARTED");

    while (scanning) {
        try {
            const trades = await parallelScan();

            if (trades.length > 0) {
                tradeBuffer.push(...trades);
            }

        } catch (e) {
            console.log("❌ SCAN ERROR:", e.message);

            provider = newProvider();
            rebuildContracts();
        }
    }
}

/* ================= EXECUTOR ================= */

async function executorLoop() {
    console.log("🔥 EXECUTOR STARTED");

    while (true) {
        try {
            if (tradeBuffer.length === 0) {
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            const batch = tradeBuffer.splice(0, BATCH_SIZE);

            await executeBatch(batch);

        } catch (e) {
            console.log("❌ EXECUTION ERROR:", e.message);
        }
    }
}

/* ================= MOCK SCAN WRAPPER ================= */

async function parallelScan() {
    const results = [];

    for (const t of triangularPaths) {
        results.push({
            router: "QuickSwap",
            amountIn: BASE_TRADE,
            pathToToken: t.pathToToken,
            pathToUSDC: t.pathToUSDC,
            expectedProfit: MIN_PROFIT + 1n
        });

        if (results.length >= BATCH_SIZE) break;
    }

    console.log("🔎 ENTER TRI SCAN");
    return results;
}

/* ================= EXECUTE BATCH ================= */

async function executeBatch(trades) {

    console.log("\n🔥 EXECUTING BATCH");

    const before = await usdc.balanceOf(CONTRACT_ADDRESS);

    let total = 0n;
    let expected = 0n;

    for (const t of trades) {
        total += t.amountIn;
        expected += t.expectedProfit;
    }

    console.log(`USED CAPITAL ${ethers.formatUnits(total, 6)}`);
    console.log(`EXPECTED PROFIT ${ethers.formatUnits(expected, 6)}`);

    if (expected < GAS_COST_USDC) {
        console.log("❌ SKIPPED: BELOW GAS\n");
        return;
    }

    const tx = await vault.executeFlashBatchArbitrage({
        buyRouters: trades.map(t => routers.QuickSwap),
        sellRouters: trades.map(t => routers.QuickSwap),
        amountsInUSDC: trades.map(t => t.amountIn),
        pathsToToken: trades.map(t => t.pathToToken),
        pathsToUSDC: trades.map(t => t.pathToUSDC),
        deadline: Math.floor(Date.now() / 1000) + 30
    });

    await provider.waitForTransaction(tx.hash);

    const after = await usdc.balanceOf(CONTRACT_ADDRESS);

    const real = after > before ? after - before : 0n;

    console.log(`REAL PROFIT ${ethers.formatUnits(real, 6)}\n`);
}

/* ================= MAIN ================= */

(async function main() {

    console.log("🚀 BOT STARTED");

    provider = newProvider();
    rebuildContracts();

    triangularPaths = buildTriangularPaths();

    // 🔥 TRUE CONTINUOUS SYSTEM
    scanLoop();       // never stops
    executorLoop();   // never stops

})();
