import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

// ================= ENV =================
const RPC_POLYGON = process.env.RPC_POLYGON || process.env.RPC_URL || "";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || "";

// ================= CONSTANTS =================
const FLASH_AMOUNT_USDC = 10000;      // Fixed flash loan amount
const SCAN_INTERVAL_MS = 10_000;      // 10 seconds between scans
const DEADLINE_SECONDS = 60;          // Swap deadline
const FLASH_PREMIUM_BPS = 9;          // 0.09% typical Aave V3 fee

// ================= PROVIDER =================
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ================= CONTRACT =================
const VAULT_ADDRESS = "0x901bFCb41EacB5fB54d89676b45042fABAdb03B9";
const vaultAbi = [
  {
    name: "executeFlashArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "address[]" },
      { type: "uint256" }
    ]
  },
  { name: "usdc", type: "function", stateMutability: "view", outputs: [{ type: "address" }] }
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ================= ROUTERS =================
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

// ================= TOKENS =================
const TOKENS = {
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

// ================= ROUTER ABI =================
const routerAbi = ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"];

// ================= HELPERS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function logStep(step, data = "") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${step}:`, data);
}

// Display wallet and vault balances
async function displayBalances() {
  try {
    const maticBalance = await provider.getBalance(wallet.address);
    const usdcAddress = await vault.usdc();
    const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
    const usdc = new ethers.Contract(usdcAddress, erc20Abi, provider);
    const vaultBalance = await usdc.balanceOf(VAULT_ADDRESS);
    const decimals = await usdc.decimals();

    console.log("Wallet MATIC:", ethers.formatEther(maticBalance));
    console.log("Vault USDC:", ethers.formatUnits(vaultBalance, decimals));
  } catch (err) {
    console.error("Balance display error:", err.message);
  }
}

// ================= SIMULATION =================
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

    return { profit, tokenOut, usdcOut, premium };
  } catch {
    return { profit: 0n, tokenOut: 0n, usdcOut: 0n, premium: 0n };
  }
}

// ================= EXECUTION =================
async function tryFlashArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();
  const { profit, tokenOut, usdcOut, premium } = await simulateProfit(buyRouter, sellRouter, tokenAddr, usdc);

  logStep("--- SIMULATION ---");
  logStep("BUY ROUTER", buyRouter);
  logStep("SELL ROUTER", sellRouter);
  logStep("TOKEN", tokenAddr);
  logStep("BUY OUTPUT", ethers.formatUnits(tokenOut, 18));
  logStep("SELL OUTPUT", ethers.formatUnits(usdcOut, 6));
  logStep("FLASH FEE", ethers.formatUnits(premium, 6));
  logStep("EXPECTED PROFIT", ethers.formatUnits(profit, 6));

  if (profit <= 0n) {
    logStep("SKIPPED", "Not profitable");
    return;
  }

  logStep("FLASH LOAN SENT");
  try {
    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      ethers.parseUnits(FLASH_AMOUNT_USDC.toString(), 6),
      [usdc, tokenAddr],
      [tokenAddr, usdc],
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );
    logStep("TX HASH", tx.hash);

    await tx.wait();
    logStep("FLASH ARBITRAGE CONFIRMED", tx.hash);

    await displayBalances();
    logStep("PROFIT DEPOSITED TO VAULT");
  } catch (err) {
    logStep("FLASH EXECUTION FAILED", err.shortMessage || err.message);
  }
}

// ================= SCAN =================
async function scan() {
  logStep("SCAN START", new Date().toISOString());
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

// ================= MAIN LOOP =================
(async function mainLoop() {
  logStep("🚀 Blind Flash-enabled Arbitrage Bot Started");

  while (true) {
    try {
      await scan();
    } catch (err) {
      logStep("SCAN ERROR", err.message);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
})();
