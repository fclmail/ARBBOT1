import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = .75;
const MIN_EXPECTED_PROFIT = 0.000001; // realistic threshold
const SCAN_INTERVAL_MS = 8000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT ================= */
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

const vaultAbi = [
  {
    name: "executeFlashBatchArbitrage",
    type: "function",
    inputs: [
      { name: "buyRouters", type: "address[]" },
      { name: "sellRouters", type: "address[]" },
      { name: "amountsInUSDC", type: "uint256[]" },
      { name: "pathsToToken", type: "address[][]" },
      { name: "pathsToUSDC", type: "address[][]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= QUICKSWAP ================= */
const QUICKSWAP_ROUTER =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const router = new ethers.Contract(
  QUICKSWAP_ROUTER,
  routerAbi,
  provider
);

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logBalances() {
  const usdcAbi = [
    "function balanceOf(address owner) view returns (uint256)"
  ];

  const usdc = new ethers.Contract(
    TOKENS.USDC,
    usdcAbi,
    provider
  );

  const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
  const formatted = ethers.formatUnits(vaultUSDC, 6);

  console.log(`${CYAN}Vault USDC Balance:${RESET} ${formatted}`);
}

async function quote(amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= TRIANGULAR ARB ================= */
async function triangularArb() {

  await logBalances();

  const amountIn = ethers.parseUnits(
    MIN_TRADE_USDC.toString(),
    6
  );

  const path1 = [TOKENS.USDC, TOKENS.WMATIC];
  const path2 = [TOKENS.WMATIC, TOKENS.WETH];
  const path3 = [TOKENS.WETH, TOKENS.USDC];

  const out1 = await quote(amountIn, path1);
  if (!out1) return console.log("Path1 failed");

  const out2 = await quote(out1, path2);
  if (!out2) return console.log("Path2 failed");

  const out3 = await quote(out2, path3);
  if (!out3) return console.log("Path3 failed");

  const finalUSDC = Number(
    ethers.formatUnits(out3, 6)
  );

  const profit = finalUSDC - MIN_TRADE_USDC;

  console.log(
    `${YELLOW}Scan:${RESET} Final ${finalUSDC.toFixed(6)} | Profit ${profit.toFixed(6)}`
  );

  if (profit < MIN_EXPECTED_PROFIT) {
    console.log("No profitable triangular opportunity");
    return;
  }

  console.log(`${GREEN}TRIANGLE PROFIT FOUND${RESET}`);

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {

    await vault.executeFlashBatchArbitrage.staticCall(
      [QUICKSWAP_ROUTER],
      [QUICKSWAP_ROUTER],
      [amountIn],
      [[TOKENS.USDC, TOKENS.WMATIC, TOKENS.WETH]],
      [[TOKENS.WETH, TOKENS.USDC]],
      deadline
    );

    console.log("Static simulation passed");

    const estimatedGas =
      await vault.executeFlashBatchArbitrage.estimateGas(
        [QUICKSWAP_ROUTER],
        [QUICKSWAP_ROUTER],
        [amountIn],
        [[TOKENS.USDC, TOKENS.WMATIC, TOKENS.WETH]],
        [[TOKENS.WETH, TOKENS.USDC]],
        deadline
      );

    const gasLimit = (estimatedGas * 120n) / 100n;

    const tx =
      await vault.executeFlashBatchArbitrage(
        [QUICKSWAP_ROUTER],
        [QUICKSWAP_ROUTER],
        [amountIn],
        [[TOKENS.USDC, TOKENS.WMATIC, TOKENS.WETH]],
        [[TOKENS.WETH, TOKENS.USDC]],
        deadline,
        { gasLimit }
      );

    console.log(`${GREEN}TX SENT:${RESET} ${tx.hash}`);

    await tx.wait();

    console.log(`${GREEN}TRIANGLE CONFIRMED${RESET}`);

    await logBalances();

  } catch (err) {
    console.log(`${RED}Execution failed:${RESET}`, err.reason || err.message);
  }
}

/* ================= LOOP ================= */
async function main() {
  while (true) {
    await triangularArb();
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
