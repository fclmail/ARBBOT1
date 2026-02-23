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

/* ================= CONSTANTS ================= */

const SCAN_AMOUNT_USDC = 0.02;          // SCAN AT 0.02
const FLASH_AMOUNT_USDC = 10000;        // SIMULATE 10,000
const MIN_EXPECTED_PROFIT = 0.000001;
const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

/* ================= COLORS ================= */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= FLASH CONTRACT ================= */

const FLASH_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const flashAbi = [
  {
    name: "executeFlashArbitrage",
    type: "function",
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
];

const flash = new ethers.Contract(FLASH_ADDRESS, flashAbi, wallet);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= ARBITRAGE ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = TOKENS.USDC;

  const scanAmount = ethers.parseUnits(
    SCAN_AMOUNT_USDC.toString(),
    6
  );

  const buyPath = [usdc, tokenAddr];
  const sellPath = [tokenAddr, usdc];

  const buyOut = await quote(buyRouter, scanAmount, buyPath);
  if (!buyOut) return;

  const sellOut = await quote(sellRouter, buyOut, sellPath);
  if (!sellOut) return;

  const profit =
    Number(ethers.formatUnits(sellOut, 6)) - SCAN_AMOUNT_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log(
    `\n${profit.toFixed(7)} PROFIT FOUND`
  );

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const flashAmount = ethers.parseUnits(
    FLASH_AMOUNT_USDC.toString(),
    6
  );

  console.log(`SIMULATING 10000 FLASH LOAN`);

  try {
    await flash.callStatic.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      flashAmount,
      buyPath,
      sellPath,
      deadline
    );

    console.log(`${GREEN}SIMULATION PASS${RESET}`);

    const tx = await flash.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      flashAmount,
      buyPath,
      sellPath,
      deadline
    );

    console.log(
      `${GREEN}ARBITRAGE EXECUTED ${tx.hash}${RESET}`
    );

  } catch {
    console.log(`${RED}SIMULATION FAILED${RESET}`);
  }
}

/* ================= MAIN LOOP ================= */

async function main() {
  while (true) {

    console.log(`\nSCANNING AT 0.02 TRADE AMOUNT`);

    for (const [buyName, buyAddr] of Object.entries(routers)) {
      for (const [sellName, sellAddr] of Object.entries(routers)) {
        if (buyAddr !== sellAddr) {
          console.log(`Checking: ${buyName} -> ${sellName}`);
          for (const tokenAddr of Object.values(TOKENS)) {
            await tryArb(buyAddr, sellAddr, tokenAddr);
          }
        }
      }
    }

    console.log(`Waiting ${SCAN_INTERVAL_MS / 1000}s...`);
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
