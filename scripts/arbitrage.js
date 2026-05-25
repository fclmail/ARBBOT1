import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();
const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = 0.03;
const MIN_EXPECTED_PROFIT = 0.000001;
const SCAN_INTERVAL_MS = 5000;
const DEADLINE_SECONDS = 6000;
const TARGET_BATCH_SIZE = 2;
const WORKERS = 16;

/* ================= TRADE BUFFER ================= */
let tradeBuffer = [];

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0x6dED2f1A44Ac58201510ddd56677ecb864Af5467";

const vaultAbi = [
  {
    "inputs": [
      {
        "components": [
          { "name": "buyRouters", "type": "address[]" },
          { "name": "sellRouters", "type": "address[]" },
          { "name": "amountsInUSDC", "type": "uint256[]" },
          { "name": "pathsToToken", "type": "address[][]" },
          { "name": "pathsToUSDC", "type": "address[][]" }
        ],
        "name": "p",
        "type": "tuple"
      },
      { "name": "deadline", "type": "uint256" }
    ],
    "name": "executeFlashBatchArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= USDC ================= */
const usdcAbi = ["function balanceOf(address owner) view returns (uint256)"];

const usdc = new ethers.Contract(
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  usdcAbi,
  provider
);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

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

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodeError(err) {
  return (
    err?.reason ||
    err?.shortMessage ||
    err?.info?.error?.message ||
    err?.message ||
    "Unknown error"
  );
}

async function logBalances() {

  const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
  const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);

  const maticBalance = await provider.getBalance(wallet.address);
