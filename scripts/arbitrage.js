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
