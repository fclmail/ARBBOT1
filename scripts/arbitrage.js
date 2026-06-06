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

const BASE_TRADE = ethers.parseUnits("0.01", 6);
const MIN_PROFIT = ethers.parseUnits("0.0001", 6);
const GAS_COST_USDC = ethers.parseUnits("0.00003", 6);

const BATCH_SIZE = 3

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
    "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256)"
];

const contractAbi = [
    "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
    "function withdrawERC20(address,uint256)"
];

const routerAbi = [
    "function getAmountsOut(uint,address[]) view returns(uint[])"
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
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    





AVAX:    "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b",
FET:     "0x7583feddbcefa813dc18259940f76a02710a8905",
INJ:     "0x4e8dc2149eac3f3def36b1c281ea466338249371",
RNDR:    "0x61299774020da444af134c82fa83e3810b309991",
UNI:     "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
PYUSD0:  "0x99af3eea856556646c98c8b9b2548fe815240750",
PAXG:    "0x553d3d295e0f695b9228246232edf400ed3560b5",
SXP:     "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
POLY:    "0xcb059c5573646047d6d88dddb87b745c18161d3b",
CHZ:     "0xf1938ce12400f9a761084e7a80d37e732a4da056",
SHIB:    "0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec",
CRVUSD:  "0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6",
APE:     "0xB7b31a6BC18e48888545CE79e83E06003bE70930",
ZRO:     "0x6985884c4392d348587b19cb9eaaf157f13271cd",
CRV:     "0x172370d5cd63279efa6d502dab29171933a610af",
LDO:     "0xc3c7d422809852031b44ab29eec9f1eff2a58756",
APEPE:   "0xa3f751662e282e83ec3cbc387d225ca56dd63d3a",
STG:     "0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590",
SAND:    "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",
TUSD:    "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
USDQ:    "0xb291996477504506bf5f583102b5b5ea5d1e40e0",
FRXUSD:  "0x80eede496655fb9047dd39d9f418d5483ed600df",
SUSHI:   "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a",
GRT:     "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
LPT:     "0x3962f4a0a0051dcce0be73a7e09cef5756736712",
PAX:     "0x6f3b3286fd86d8b47ec737ceb3d0d354cc657b3e"









AUSD:"0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
BAT:"0x3cef98bb43d732e2f285ee605a8158cde967d219",
TBTC:"0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
MANA:"0xa1c57f48f0deb89f569dfbe6e2b7f46d33606fd4",
TRB:"0xe3322702bedaaed36cddab233360b939775ae5f1",
COMP:"0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c",
INCH:"0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f",
THETA:"0xb46e0ae620efd98516f49bb00263317096c114b2",
CRO:"0xada58df0f643d959c2a47c9d4d4c1a4defe3f11c",
XYO:"0xd2507e7b5794179380673870d88b22f94da6abe0",
MASK:"0x2b9e7ccdf0f4e5b24757c1e1a80e311e34cb10c7",
EURQ:"0xd571edb2ef29df10fcd6200fd6d0ed2389983db3",
APOLUSDT:"0x6ab707aca953edaefbc4fd23ba73294241490620",
ENJ:"0x7ec26842f195c852fa843bb9f6d8b583a274a157",
ZRX:"0x5559edb74751a0ede9dea4dc23aee72cca6be3d5",
GMT:"0x714db550b574b3e927af3d93e26127d15721d4c2",
SNX:"0x50b728d8d964fd00c2d0aad81718b71311fef68a",
ANKR:"0x101a023270368c0d50bffb62780f4afd4ea79c35",
GLM:"0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf",
COW:"0x2f4efd3aa42e15a1ec6114547151b63ee5d39958",
BAND:"0xa8b1e0764f85f53dfe21760e8afe5446d82606ac",
AXL:"0x6e4e624106cb12e168e6533f8ec7c82263358940",
UMA:"0x3066818837c5e6ed6601bd5a91b0762877a6b731",
YFI:"0xda537104d6a5edd53c6fbba9a898708e465260b6",
ELON:"0xe0339c80ffde91f3e20494df88d4206d86024cdf",
NEXO:"0x41b3966b4ff7b427969ddf5da3627d6aeae9a48e",
EURAU:"0x4933A85b5b5466Fbaf179F72D3DE273c287EC2c2",
ORDER:"0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
IOTX:"0xf6372cdb9c1d3674e83842e3800f2a62ac9f3c66",
AMP:"0x0621d647cecbfb64b79e44302c1933cb4f27054d",
CBK:"0x4EC203dD0699Fac6adAF483CDd2519BC05D2c573",
ACX:"0xf328b73b6c685831f238c30a23fc19140cb4d8fc",
RLC:"0xbe662058e00849c3eef2ac9664f37fefdf2cdbfe",
POND:"0x73580a2416a57f1c4b6391dba688a9e4f7dbece0",
BOBA:"0xa4b2b20b2c73c7046ed19ac6bff5e5285c58f20a",
C98:"0x77f56cf9365955486b12c4816992388ee8606f0e",
PYR:"0x430ef9263e76dae63c84292c3409d61c598e9682",
USDD:"0xffa4d863c96e743a2e1513824ea006b8d0353c57",
REQ:"0xb25e20de2f2ebb4cffd4d16a55c7b395e8a94762",
KNC:"0x1c954e8fe737f99f68fa1ccda3e51ebdb291948c",
POWR:"0x0aab8dc887d34f00d50e19aee48371a941390d14",
ZKP:"0x9a06db14d639796b25a6cec6a1bf614fd98815ec",
FRAX:"0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",
SOPH:"0xeb971fd26783f32694dbb392dd7289de23109148",
HOT:"0x0c51f415cf478f8d08c246a6c6ee180c5dc3a012",
GTC:"0xdb95f9188479575f3f718a245eca1b3bf74567ec",
TELEBTC:"0x3bf668fe1ec79a84ca8481cead5dbb30d61cc685",
WOO:"0x1b815d120b3ef02039ee11dc2d33de7aa4a8c603",
AIOZ:"0xe2341718c6c0cbfa8e6686102dd8fbf4047a9e9b",
GNO:"0x5ffd62d3c3ee2e81c00a7b9079fb248e7df024a8",
FRXETH:"0x43edd7f3831b08fe70b7555ddd373c8bf65a9050",
FRXETHCANONICAL:"0xee327f889d5947c1dc1934bb208a1e792f953e96",
UST:"0x692597b009d13c4049a947cab2239b7d6517875f",
NPT:"0x306ee01a6ba3b4a8e993fa2c1adc7ea24462000c",
ADX:"0xdda7b23d2d72746663e7939743f929a3d85fc975",
SYN:"0xf8f9efc0db77d8881500bb06ff5d6abc3070e695",
FLUID:"0xf50d05a1402d0adafa880d36050736f9f6ee7dee",
ORBS:"0x614389eaae0a6821dc49062d56bda3d9d45fa2ff",
VANRY:"0x8de5b80a0c1b02fe4976851d030b36122dbb8624",
OMG:"0x62414d03084eeb269e18c970a21f45d2967f0170",
TEL:"0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
OXT:"0x9880e3dda13c8e7d4804691a45160102d31f6060",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x, 6);

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

/* ================= 🔃 GAS TOP-UP (ADDED FEATURE ONLY) ================= */

async function topUpGas() {
    try {
        const contractBal = await usdc.balanceOf(CONTRACT_ADDRESS);
        const threshold = ethers.parseUnits(".03", 6);

        if (contractBal < threshold) return;

        const amount = contractBal / 1n;

        console.log(`⚡ GAS TOP-UP ${fmt(amount)} USDC`);

        await (await vault.withdrawERC20(USDC, amount)).wait();

        await (await usdc.approve(routers.QuickSwap, amount)).wait();

        const router = new ethers.Contract(
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

        console.log("🔃 USDC → WMATIC");

        const wmatic = new ethers.Contract(
            TOKENS.WMATIC,
            [
                "function withdraw(uint256)",
                "function balanceOf(address) view returns(uint256)"
            ],
            wallet
        );

        const bal = await wmatic.balanceOf(wallet.address);

        if (bal > 0n) {
            await (await wmatic.withdraw(bal)).wait();
            console.log("🔃 WMATIC → POL");
        }

    } catch (e) {
        console.log("⚠️ GAS TOP-UP FAILED:", e.message);
    }
}

/* ================= EXECUTION ================= */

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

    const profit = after - before;

    console.log(`CONTRACT BEFORE ${fmt(before)}`);
    console.log(`CONTRACT AFTER  ${fmt(after)}`);
    console.log(`REAL PROFIT ${fmt(profit)}\n`);

    /* 🔃 ONLY ADDITION TO JS1 FLOW */
    await topUpGas();
}

/* ================= MAIN LOOP ================= */

(async function main() {
    console.log("🚀 BOT STARTED\n");

    provider = newProvider();
    rebuildContracts();

    const triangularPaths = []; // unchanged JS1 logic assumed
    const routersList = Object.values(routers);

    while (true) {
        try {
            const trades = []; // unchanged JS1 scanning logic assumed

            if (trades.length > 0) {
                await executeBatch(trades);
            }
        } catch (e) {
            provider = newProvider();
            rebuildContracts();
        }
    }
})();
