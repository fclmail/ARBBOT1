

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
//   "https://polygon-mainnet.core.chainstack.com/46058733cb4d6319063e68f8673791a8",
    // Add more RPCs for redundancy
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

    TOKENA: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
TOKENB: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
TOKENC: "0x3BA4c387f786bFEE076A58914F5Bd38d668B42c3",
TOKEND: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
TOKENE: "0xd93f7e271cb87c23aaa73edc008a79646d1f9912",
TOKENF: "0x06d02e9d62a13fc76bb229373fb3bbbd1101d2fc",
TOKENG: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
TOKENH: "0xf854225caaef5a722884a68a23215dfa5386751e",
TOKENI: "0xb0897686c545045afc77cf20ec7a532e3120e0f1",
TOKENJ: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
TOKENK: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
TOKENL: "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8",
TOKENM: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
TOKENN: "0x99af3eea856556646c98c8b9b2548fe815240750",
TOKENO: "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b",
TOKENP: "0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
TOKENQ: "0x2893Ef551B6dD69F661Ac00F11D93E5Dc5Dc0e99",
TOKENR: "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec",
TOKENS: "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
TOKENT: "0x553d3d295e0f695b9228246232edf400ed3560b5",
TOKENU: "0xffa4d863c96e743a2e1513824ea006b8d0353c57",
TOKENV: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
TOKENW: "0xa0769f7a8fc65e47de93797b4e21c073c117fc80",
TOKENX: "0x61299774020da444af134c82fa83e3810b309991",
TOKENY: "0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
TOKENZ: "0x0266F4F08D82372CF0FcbCCc0Ff74309089c74d1",

TOKENAA: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
TOKENAB: "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
TOKENAC: "0x4e8dc2149eac3f3def36b1c281ea466338249371",
TOKENAD: "0x7583feddbcefa813dc18259940f76a02710a8905",
TOKENAE: "0x172370d5cd63279efa6d502dab29171933a610af",
TOKENAF: "0xc3c7d422809852031b44ab29eec9f1eff2a58756",
TOKENAG: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
TOKENAH: "0x5ffd62d3c3ee2e81c00a7b9079fb248e7df024a8",
TOKENAI: "0x6985884c4392d348587b19cb9eaaf157f13271cd",
TOKENAJ: "0xcb059c5573646047d6d88dddb87b745c18161d3b",
TOKENAK: "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
TOKENAL: "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",
TOKENAM: "0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6",
TOKENAN: "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a",
TOKENAO: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
TOKENAP: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
TOKENAQ: "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
TOKENAR: "0xf1938ce12400f9a761084e7a80d37e732a4da056",
TOKENAS: "0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
TOKENAT: "0xe4880249745eac5f1ed9d8f7df844792d560e750",
TOKENAU: "0x67ce67ec4fcd4aca0fcb738dd080b2a21ff69d75",
TOKENAV: "0xB7b31a6BC18e48888545CE79e83E06003bE70930",
TOKENAW: "0xb46e0ae620efd98516f49bb00263317096c114b2",
TOKENAX: "0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
TOKENAY: "0x50b728d8d964fd00c2d0aad81718b71311fef68a",
TOKENAZ: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",

TOKENBA: "0x3cef98bb43d732e2f285ee605a8158cde967d219",
TOKENBB: "0x43eDD7f3831b08FE70B7555ddD373C8bF65a9050",
TOKENBC: "0xee327f889d5947c1dc1934bb208a1e792f953e96",
TOKENBD: "0xFCe60bBc52a5705CeC5B445501FBAf3274Dc43D0",
TOKENBE: "0xf1815bd50389c46847f0bda824ec8da914045d14",
TOKENBF: "0x80eede496655fb9047dd39d9f418d5483ed600df",
TOKENBG: "0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
TOKENBH: "0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
TOKENBI: "0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
TOKENBJ: "0xf50d05a1402d0adafa880d36050736f9f6ee7dee",
TOKENBK: "0x3Ec3849C33291a9eF4c5dB86De593EB4A37fDe45",
TOKENBL: "0x6d1fdbb266fcc09a16a22016369210a15bb95761",
TOKENBM: "0xda537104d6a5edd53c6fbba9a898708e465260b6",
TOKENBN: "0x3962f4a0a0051dcce0be73a7e09cef5756736712",
TOKENBO: "0x8a16d4bf8a0a716017e8d2262c4ac32927797a2f",
TOKENBP: "0x5559edb74751a0ede9dea4dc23aee72cca6be3d5",
TOKENBQ: "0x07cc1cc3628cc1615120df781ef9fc8ec2feae09",
TOKENBR: "0xA7E22972a19dd924aFeEDf3Db28033B146801081",
TOKENBS: "0x0c51f415cf478f8d08c246a6c6ee180c5dc3a012",
TOKENBT: "0xe2341718c6c0cbfa8e6686102dd8fbf4047a9e9b",
TOKENBU: "0x2c72d25530191ebd244eb6325e1892480b0e6e28",
TOKENBV: "0x7ec26842f195c852fa843bb9f6d8b583a274a157",
TOKENBW: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
TOKENBX: "0x4ed141110f6eeeaba9a1df36d8c26f684d2475dc",
TOKENBY: "0x6e4e624106cb12e168e6533f8ec7c82263358940",
TOKENBZ: "0xf8f9efc0db77d8881500bb06ff5d6abc3070e695",

TOKENCA: "0x236eec6359fb44cce8f97e99387aa7f8cd5cde1f",
TOKENCB: "0x4e36d8006416ea1d939a0eeae73afdaca86bd376",
TOKENCC: "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a",
TOKENCD: "0x98965474ecbec2f532f1f780ee37b0b05f77ca55",
TOKENCE: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
TOKENCF: "0xd2507e7b5794179380673870d88b22f94da6abe0",
TOKENCG: "0xC53fA49ba78bC02D3eB2858b456C95CB6DcB52Cf",
TOKENCH: "0x8Cf745561791A43d70F75e85FbC6e3752395C5f0",
TOKENCI: "0xe3322702bedaaed36cddab233360b939775ae5f1",
TOKENCJ: "0x7205705771547cf79201111b4bd8aaf29467b9ec",
TOKENCK: "0xb25e20de2f2ebb4cffd4d16a55c7b395e8a94762",
TOKENCL: "0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7",
TOKENCM: "0xc8a94a3d3d2dabc3c1caffffdca6a7543c3e3e65",
TOKENCN: "0x0621d647cecbfb64b79e44302c1933cb4f27054d",
TOKENCO: "0xe78649874bcdb7a9d1666e665f340723a0187482",
TOKENCP: "0x101a023270368c0d50bffb62780f4afd4ea79c35",
TOKENCQ: "0xff7f8f301f7a706e3cfd3d2275f5dc0b9ee8009b",
TOKENCR: "0x3066818837c5e6ed6601bd5a91b0762877a6b731",
TOKENCS: "0x6f3b3286fd86d8b47ec737ceb3d0d354cc657b3e",
TOKENCT: "0x779b299ea455d35a44fe9bac48648be22c08dea2",
TOKENCU: "0xe0339c80ffde91f3e20494df88d4206d86024cdf",
TOKENCV: "0x692597b009d13c4049a947cab2239b7d6517875f",
TOKENCW: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
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
const CACHE_TTL = 1000; // 1 second cache TTL

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
    // Clean up old cache entries if map gets too large
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
    // Check cache first
    const cached = getCachedQuote(router, path);
    if (cached !== undefined) return cached;

    try {
        const out = await routerContracts[router].getAmountsOut(amount, path);
        const result = out.at(-1);
        setCachedQuote(router, path, result);
        return result;
    } catch {
        // Cache null results too to avoid repeated failures
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

    // Create chunks for parallel scanning
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

        // Execute parallel scans with concurrency control
        const results = await Promise.all(scanPromises);
        batchResults.push(...results.filter(r => r !== null));

        // If we have enough trades, break early
        if (batchResults.length >= BATCH_SIZE) {
            break;
        }
    }

    return batchResults.slice(0, BATCH_SIZE);
}

/* ================= EXECUTE ================= */

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

    const real = after > before ? after - before : 0n;

    console.log(`CONTRACT BEFORE ${fmt(before)}`);
    console.log(`CONTRACT AFTER  ${fmt(after)}`);
    console.log(`REAL PROFIT     ${fmt(real)}\n`);

    await topUpGas();}

/* ================= GAS TOP-UP ================= */

async function topUpGas() {

    try {

        const contractBal =
            await usdc.balanceOf(CONTRACT_ADDRESS);

        if (contractBal < WITHDRAW_THRESHOLD)
            return;

        const amount =
            (contractBal * WITHDRAW_PERCENT) / 100n;

        console.log(
            `⚡ GAS TOP-UP ${fmt(amount)} USDC`
        );

        await (
    await vault.withdraw(
        amount
    )
       ).wait();

        await (
            await usdc.approve(
                routers.QuickSwap,
                amount
            )
        ).wait();

        const router =
            new ethers.Contract(
                routers.QuickSwap,
                routerAbi,
                wallet
            );

        await (
            await router.swapExactTokensForTokens(
                amount,
                0,
                [USDC, TOKENS.WMATIC],
                wallet.address,
                Math.floor(Date.now() / 1000) + 120
            )
        ).wait();

        console.log(
            "✅ USDC → WMATIC"
        );

        const wmatic =
            new ethers.Contract(
                TOKENS.WMATIC,
                [
                    "function withdraw(uint256)",
                    "function balanceOf(address) view returns(uint256)"
                ],
                wallet
            );

        const bal =
            await wmatic.balanceOf(
                wallet.address
            );

        if (bal > 0n) {

            await (
                await wmatic.withdraw(bal)
            ).wait();

            console.log(
                "🔥 WMATIC → POL"
            );
        }

    } catch (e) {

        console.log(
            `⚠️ GAS TOP-UP FAILED: ${e.message}`
        );
    }
}





/* ================= MAIN ================= */

(async function main() {
    console.log("🚀 BOT STARTED\n");

    provider = newProvider();
    rebuildContracts();

    const triangularPaths = buildTriangularPaths();
    const routersList = Object.values(routers);

    let batch = [];

    while (true) {
        try {
            // Parallel scanning with caching
            const trades = await parallelScan(triangularPaths, routersList);

            if (trades.length > 0) {
                await executeBatch(trades);
            } else {
                // Small delay if no profitable trades found
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            console.error("❌ Error in main loop:", error.message);
            // Reconnect on error
            provider = newProvider();
            rebuildContracts();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
})();
