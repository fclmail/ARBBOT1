import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const WALLET_PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

/* ================= CONSTANTS ================= */

const FLASH_AMOUNT_USDC = 0.20;
const MIN_EXPECTED_PROFIT = 0.000001; // minimum profit
const SCAN_INTERVAL_MS = 10_000; // 10 seconds
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS =
  "0x901bFCb41EacB5fB54d89676b45042fABAdb03B9";

const vaultAbi = [
  {
    name: "executeFlashArbitrage",
    type: "function",
    inputs: [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "address[]" },
      { type: "uint256" }
    ],
    stateMutability: "nonpayable"
  },
  {
    name: "usdc",
    type: "function",
    outputs: [{ type: "address" }],
    stateMutability: "view"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

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
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
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

function buildPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token]
  ];
}

function buildSellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc]
  ];
}

/* ================= BALANCES ================= */

async function displayBalances() {
  const maticBalance = await provider.getBalance(wallet.address);
  const usdcAddress = await vault.usdc();

  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)"
  ];

  const usdc = new ethers.Contract(usdcAddress, erc20Abi, provider);
  const contractBalance = await usdc.balanceOf(VAULT_ADDRESS);
  const decimals = await usdc.decimals();

  console.log("Wallet MATIC:", ethers.formatEther(maticBalance));
  console.log("Contract USDC:", ethers.formatUnits(contractBalance, decimals));
}

/* ================= ARBITRAGE ================= */

async function tryFlashArb(buyRouterName, buyRouter, sellRouterName, sellRouter, tokenName, tokenAddr) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(FLASH_AMOUNT_USDC.toString(), 6);

  let bestBuyOut, bestBuyPath;
  for (const p of buildPaths(usdc, tokenAddr)) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyOut) return;

  let bestSellOut, bestSellPath;
  for (const p of buildSellPaths(usdc, tokenAddr)) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }
  if (!bestSellOut) return;

  const gross =
    Number(ethers.formatUnits(bestSellOut, 6)) - FLASH_AMOUNT_USDC;

  console.log(
    `[${tokenName}] ${buyRouterName} → ${sellRouterName} | Gross: ${gross.toFixed(6)}`
  );

  if (gross < MIN_EXPECTED_PROFIT) return;

  console.log(`💰 PROFIT FOUND: ${gross.toFixed(6)} USDC`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {
    await vault
      .connect(wallet)
      .executeFlashArbitrage.staticCall(
        buyRouter,
        sellRouter,
        amountIn,
        bestBuyPath,
        bestSellPath,
        deadline
      );

    console.log(`✅ Static simulation passed`);
  } catch (err) {
    console.log(`⚡ Simulation failed`);
  }
}

/* ================= SCAN ================= */

async function scan() {
  for (const [tokenName, token] of Object.entries(TOKENS)) {
    for (const [buyName, buy] of Object.entries(routers)) {
      for (const [sellName, sell] of Object.entries(routers)) {
        if (buy !== sell) {
          await tryFlashArb(buyName, buy, sellName, sell, tokenName, token);
        }
      }
    }
  }
}

/* ================= MAIN ================= */

(async function mainLoop() {
  console.log("🚀 Flash-enabled arbitrage bot started");

  while (true) {
    console.log(`\n🧪 Simulation started @ ${new Date().toISOString()}`);
    await displayBalances();

    await scan();

    console.log(`⏳ Waiting 10 seconds for next simulation...\n`);
    await sleep(SCAN_INTERVAL_MS);
  }
})();
