import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON = process.env.RPC_POLYGON || "";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

// Validate private key
if (!WALLET_PRIVATE_KEY || !/^0x[a-fA-F0-9]{64}$/.test(WALLET_PRIVATE_KEY)) {
  throw new Error(
    "Invalid or missing private key. Please check your .env or GitHub Secrets."
  );
}

/* ================= CONSTANTS ================= */
const FLASH_AMOUNT_USDC = 10000; // amount for flash loan
const SCAN_INTERVAL_MS = 10_000; // 10 seconds
const DEADLINE_SECONDS = 60; // 1 min
const FLASH_PREMIUM_BPS = 9; // Aave 0.09% typical

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT ================= */
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

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
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
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

async function displayBalances() {
  try {
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
    console.log("Vault USDC:", ethers.formatUnits(contractBalance, decimals));
  } catch (err) {
    console.error("Balance display error:", err.message);
  }
}

/* ================= PROFIT SIMULATION ================= */
async function simulateProfit(buyRouterAddr, sellRouterAddr, tokenAddr, usdcAddr) {
  try {
    const buyRouter = new ethers.Contract(buyRouterAddr, routerAbi, provider);
    const sellRouter = new ethers.Contract(sellRouterAddr, routerAbi, provider);

    const amountIn = ethers.parseUnits(FLASH_AMOUNT_USDC.toString(), 6);
    const buyAmounts = await buyRouter.getAmountsOut(amountIn, [usdcAddr, tokenAddr]);
    const tokenOut = buyAmounts[1];
    const sellAmounts = await sellRouter.getAmountsOut(tokenOut, [tokenAddr, usdcAddr]);
    const usdcOut = sellAmounts[1];

    const premium = (amountIn * BigInt(FLASH_PREMIUM_BPS)) / BigInt(10000);
    const profit = usdcOut - amountIn - premium;

    return profit;
  } catch {
    return BigInt(0);
  }
}

/* ================= FLASH EXECUTION ================= */
async function tryFlashArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();
  const profit = await simulateProfit(buyRouter, sellRouter, tokenAddr, usdc);

  if (profit <= 0n) return;

  console.log("Profitable opportunity found:", ethers.formatUnits(profit, 6), "USDC");
  try {
    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      ethers.parseUnits(FLASH_AMOUNT_USDC.toString(), 6),
      [usdc, tokenAddr],
      [tokenAddr, usdc],
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );

    console.log("Flash loan sent:", tx.hash);
    await tx.wait();
    console.log("Flash arbitrage confirmed:", tx.hash);

    await displayBalances();
    console.log("Profit deposited to vault ✅");
  } catch (err) {
    console.error("Flash execution failed:", err.shortMessage || err.message);
  }
}

/* ================= SCAN LOOP ================= */
async function scan() {
  console.log("\nScan @", new Date().toISOString());
  await displayBalances();

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await tryFlashArb(buy, sell, token);
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */
(async function mainLoop() {
  console.log("🚀 Blind Flash-enabled Arbitrage Bot Started");

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
})();
