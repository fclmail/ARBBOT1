import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
//🟢1 Loads RPC + wallet key from .env
const RPC_POLYGON =
  (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");


/* ================= COLORS ================= */
//🟢2 Console colors for logs only
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";


/* ================= CONSTANTS ================= */
//🟢3 MAIN TUNING SECTION

const MIN_TRADE_USDC = 0.030;
const TARGET_BATCH_SIZE = 2;
const SCAN_INTERVAL_MS = 400;
const DEADLINE_SECONDS = 60;
const NUM_WORKERS = 32;


/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);


/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};


/* ================= FACTORIES ================= */

const factories = {
  QuickSwap: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  SushiSwap: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
  ApeSwap: "0xcf083be4164828f00cae704ec15a36d711491284",
  Wault: "0xb6c8f9e5a7d62c3a7ef7fdf7b8e4c0e5efb1e77d"
};


/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};


/* ================= ABIS ================= */

const factoryAbi = [
  "function getPair(address,address) view returns(address)"
];

const pairAbi = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)"
];


/* ================= VAULT ================= */

const VAULT_ADDRESS = "0xf7e8A1580Dd9b3757Fb6a1f86AD5ed0e0F3EfC31";

const vaultAbi = [{
  name: "executeFlashBatchArbitrage",
  type: "function",
  inputs: [
    { type: "address[]" },
    { type: "address[]" },
    { type: "uint256[]" },
    { type: "address[][]" },
    { type: "address[][]" },
    { type: "uint256" }
  ],
  outputs: []
}];

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  vaultAbi,
  wallet
);


/* ================= BALANCE DISPLAY ================= */

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const usdc = new ethers.Contract(
  TOKENS.USDC,
  erc20Abi,
  provider
);

async function showBalances() {

  const matic =
    await provider.getBalance(
      wallet.address
    );

  const vaultBal =
    await usdc.balanceOf(
      VAULT_ADDRESS
    );

  console.log(
    CYAN,
    "Wallet MATIC:",
    ethers.formatEther(matic)
  );

  console.log(
    CYAN,
    "Vault USDC:",
    Number(vaultBal) / 1e6,
    RESET
  );
}


/* ================= HELPERS ================= */

const sleep = (ms) =>
  new Promise(r => setTimeout(r, ms));


function decodeError(err) {
  return (
    err?.reason ||
    err?.shortMessage ||
    err?.message ||
    "Unknown error"
  );
}
