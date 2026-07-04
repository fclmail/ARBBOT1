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

/* ================= ROUTERS (Cleaned Duplicates) ================= */

const routers = {
    QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
    Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
    ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
    Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS (Cleaned Duplicates) ================= */

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
    ZRX: "0x5559edb74751a0ede9dea4dc23aee72
