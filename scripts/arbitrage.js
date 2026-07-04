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
    // Add more RPCs for redundancy
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const BASE_TRADE = ethers.parseUnits(".01", 6);
const MIN_PROFIT = ethers.parseUnits("0.0002", 6);
const GAS_COST_USDC = ethers.parseUnits("0.000003", 6);

const BATCH_SIZE = 4;

/* ================= GAS TOP-UP ================= */

const WITHDRAW_THRESHOLD = ethers.parseUnits("997973", 6);
const WITHDRAW_PERCENT = 1n;

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
    "function getAmountsOut(uint,address[]) view returns(uint[])",
    "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

/* ================= ROUTERS ================= */

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS = {
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
    APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
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
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x, 6);

/* ================= CACHE ================= */
const quoteCache = new Map();
const CACHE_TTL = 1000; 

function getCachedQuote(router, path) {
    const key = `${router}-${path.join('-')}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.value;
    }
    return undefined;
}

function setCachedQuote(router, path, value) {
    const key = `${router}-${path.join('-')}`;
    quoteCache.set(key, { value, timestamp: Date.now() });
    if (quoteCache.size > 100000) {
        const now = Date.now();
        for (const [key, entry] of quoteCache) {
            if (now - entry.timestamp > CACHE_TTL) {
                quoteCache.delete(key);
            }
        }
    }
}

/* ================= PROVIDER ================= */

function newProvider() {
    const url = RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % RPCS.length;
    return new ethers.JsonRpcProvider(url);
}

function rebuildContracts() {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    usdc = new ethers.Contract(USDC, erc20Abi, wallet);
    vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
    routerContracts = Object.fromEntries(
        Object.values(routers).map(a => [
            a,
            new ethers.Contract(a, routerAbi, provider)
        ])
    );
}

/* ================= QUOTE (with caching) ================= */

async function quote(router, amount, path) {
    const cached = getCachedQuote(router, path);
    if (cached !== undefined) return cached;

    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        const result = out.at(-1);
        setCachedQuote(router, path, result);
        return result;
    } catch {
        setCachedQuote(router, path, null);
        return null;
    }
}

/* ================= TRIANGULAR PATH BUILDER ================= */

function buildTriangularPaths() {
    const tokens = Object.values(TOKENS);
    let paths = [];

    for (const a of tokens) {
        for (const b of tokens) {
            if (a === b) continue;
            paths.push([USDC, a, b, USDC]);
        }
    }

    return paths;
}

/* ================= TRIANGULAR FINDER (parallel) ================= */

async function findTriangular(router, path) {
    const baseOut1 = await quote(router, BASE_TRADE, [path[0], path[1]]);
    if (!baseOut1) return null;

    const baseOut2 = await quote(router, baseOut1, [path[1], path[2]]);
    if (!baseOut2) return null;

    const baseOut3 = await quote(router, baseOut2, [path[2], path[3]]);
    if (!baseOut3) return null;

    const profit = baseOut3 - BASE_TRADE;

    if (profit <= 0n || profit < MIN_PROFIT) return null;

    console.log(
        `TRI FOUND ${fmt(BASE_TRADE)} → ${fmt(baseOut3)} PROFIT ${fmt(profit)}`
    );

    return {
        router,
        amountIn: BASE_TRADE,
        pathToToken: path.slice(0, 3),
        pathToUSDC: [path[2], USDC],
        expectedProfit: profit
    };
}

/* ================= PARALLEL SCANNER ================= */

async function parallelScan(paths, routersList) {
    const batchResults = [];

    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        const pathChunk = paths.slice(i, i + BATCH_SIZE);
        const scanPromises = [];

        for (const router of routersList) {
            for (const path of pathChunk) {
                scanPromises.push(
                    findTriangular(router, path).catch(() => null)
                );
            }
        }

        const results = await Promise.all(scanPromises);
        batchResults.push(...results.filter(r => r !== null));

        if (batchResults.length >= BATCH_SIZE) {
            break;
        }
    }

    return batchResults.slice(0, BATCH_SIZE);
}

/* ================= EXECUTE (FASTLANE INTEGRATION) ================= */

async function executeBatch(trades) {
    console.log("\n🔥 EXECUTING BATCH");

    const before = await usdc.balanceOf(CONTRACT_ADDRESS);

    let total = 0n;
    let expected = 0n;

    for (const t of trades) {
        total += t.amountIn;
        expected += t.expectedProfit;
    }

    console.log(`USED CAPITAL ${fmt(total)}`);
    console.log(`EXPECTED PROFIT ${fmt(expected)}`);

    if (expected < GAS_COST_USDC) {
        console.log("❌ SKIPPED: BELOW GAS\n");
        return;
    }

    // Encoded contract data block
    const targetCalldata = vault.interface.encodeFunctionData("executeFlashBatchArbitrage", [{
        buyRouters: trades.map(t => t.router),
        sellRouters: trades.map(t => t.router),
        amountsInUSDC: trades.map(t => t.amountIn),
        pathsToToken: trades.map(t => t.pathToToken),
        pathsToUSDC: trades.map(t => t.pathToUSDC),
        deadline: Math.floor(Date.now() / 1000) + 30
    }]);

    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    const feeData = await provider.getFeeData();

    const txObject = {
        to: CONTRACT_ADDRESS,
        data: targetCalldata,
        nonce: nonce,
        gasLimit: 800000n, 
        maxFeePerGas: feeData.maxFeePerGas ?? feeData.gasPrice,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? feeData.gasPrice,
        chainId: 137, 
        type: 2
    };

    const signedTx = await wallet.signTransaction(txObject);

    console.log("📡 Sending Bundle Payload directly to Fastlane Engine...");
    try {
        const response = await fetch("https://polygon.fastlane.alpha.validator-cloud.com", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "fastlane_sendBundle",
                params: [[signedTx], "0"]
            })
        });

        const resData = await response.json();
        if (resData.error) {
            console.log(`❌ Fastlane Engine Rejected Bundle: ${resData.error.message}`);
            return;
        }

        const bundleHash = resData.result;
        console.log(`🟩 Fastlane Bundle Accepted! Identification Hash: ${bundleHash}`);

        const txHash = ethers.keccak256(signedTx);
        console.log(`⏳ Monitoring execution confirmation for Tx Hash: ${txHash}`);
        await provider.waitForTransaction(txHash);

    } catch (err) {
        console.log(`⚠️ Fastlane Bundle transmission failure: ${err.message}`);
        return;
    }

    const after = await usdc.balanceOf(CONTRACT_ADDRESS);
    const real = after > before ? after - before : 0n;

    console.log(`CONTRACT BEFORE ${fmt(before)}`);
    console.log(`CONTRACT AFTER  ${fmt(after)}`);
    console.log(`REAL PROFIT     ${fmt(real)}\n`);

    await topUpGas();
}

/* ================= GAS TOP-UP ================= */

async function topUpGas() {
    try {
        const contractBal = await usdc.balanceOf(CONTRACT_ADDRESS);
        if (contractBal < WITHDRAW_THRESHOLD) return;

        const amount = (contractBal * WITHDRAW_PERCENT) / 100n;
        console.log(`⚡ GAS TOP-UP ${fmt(amount)} USDC`);

        await (await vault.withdraw(amount)).wait();
        await (await usdc.approve(routers.QuickSwap, amount)).wait();

        const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);

        await (await router.swapExactTokensForTokens(
            amount,
            0,
            [USDC, TOKENS.WMATIC],
            wallet.address,
            Math.floor(Date.now() / 1000) + 120
        )).wait();

        console.log("✅ USDC → WMATIC");

        const wmatic = new ethers.Contract(
            TOKENS.WMATIC,
