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
const BATCH_SIZE = 4;

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

/* ================= PATH GENERATION (🔥 MAIN UPGRADE) ================= */

function buildGraph() {
    const graph = {};
    const tokens = Object.values(TOKENS);

    // USDC is always entry point
    graph[USDC] = tokens;

    for (const t of tokens) {
        graph[t] = [...tokens, USDC].filter(x => x !== t);
    }

    return graph;
}

function dfsPaths(graph, start, maxDepth) {
    const results = [];

    function dfs(path, depth) {
        const last = path[path.length - 1];

        if (depth === 0) {
            results.push([...path, USDC]);
            return;
        }

        for (const next of graph[last]) {

            if (path.includes(next)) continue;

            dfs([...path, next], depth - 1);
        }
    }

    dfs([start], maxDepth);

    return results;
}

/* ================= NEW MULTI-DEPTH PATH BUILDER ================= */

function buildTriangularPaths() {

    const graph = buildGraph();

    const allPaths = [];

    // 🔥 2-hop
    allPaths.push(...dfsPaths(graph, USDC, 2));

    // 🔥 3-hop
    allPaths.push(...dfsPaths(graph, USDC, 3));

    // 🔥 4-hop (HUGE EXPANSION)
    allPaths.push(...dfsPaths(graph, USDC, 4));

    // format into router-ready paths
    const formatted = allPaths.map(p => {

        return {
            path: p,
            pathToToken: p.slice(0, -2),
            pathToUSDC: [p[p.length - 2], USDC]
        };
    });

    console.log("📦 PATHS GENERATED:", formatted.length);

    return formatted;
}

/* ================= MAIN EXPORT HOOK ================= */

(async function main() {

    console.log("🚀 BOT STARTED");

    provider = newProvider();
    rebuildContracts();

    const paths = buildTriangularPaths();

    console.log("🧭 READY PATH DEPTH: 2–4 HOPS");

})();
