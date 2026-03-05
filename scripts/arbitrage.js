// scripts/arbitrage.js

import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

/* =========================
   CONFIG
========================= */

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================
   TEST MODE SETTINGS
========================= */

// small flash loan for proof
const FLASH_LOAN_AMOUNT = ethers.parseUnits("1", 6);

// allow tiny profits
const MIN_PROFIT_USDC = 0n;

// fast scanning
const SCAN_INTERVAL_MS = 1000;

/* =========================
   TOKENS (HIGH LIQUIDITY)
========================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
};

/* =========================
   ROUTERS
========================= */

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
};

/* =========================
   ROUTER ABI
========================= */

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)"
];

/* =========================
   UTIL
========================= */

function formatUSDC(value) {
  return Number(ethers.formatUnits(value, 6));
}

/* =========================
   ARBITRAGE SIMULATION
========================= */

async function simulateArbitrage(tokenAddress) {

  const amountIn = FLASH_LOAN_AMOUNT;

  for (const [buyName, buyRouterAddr] of Object.entries(ROUTERS)) {

    for (const [sellName, sellRouterAddr] of Object.entries(ROUTERS)) {

      if (buyName === sellName) continue;

      const buyRouter = new ethers.Contract(
        buyRouterAddr,
        ROUTER_ABI,
        provider
      );

      const sellRouter = new ethers.Contract(
        sellRouterAddr,
        ROUTER_ABI,
        provider
      );

      try {

        const buyPath = [
          TOKENS.USDC,
          tokenAddress
        ];

        const sellPath = [
          tokenAddress,
          TOKENS.USDC
        ];

        const buyAmounts = await buyRouter.getAmountsOut(
          amountIn,
          buyPath
        );

        const tokensReceived = buyAmounts[1];

        const sellAmounts = await sellRouter.getAmountsOut(
          tokensReceived,
          sellPath
        );

        const returnedUSDC = sellAmounts[1];

        const netProfit = returnedUSDC - amountIn;

        console.log("------------------------------------------------");
        console.log("Simulation started");

        console.log(
          `Buy path: USDC -> ${tokenAddress}`
        );

        console.log(
          `Sell path: ${tokenAddress} -> USDC`
        );

        console.log(
          `Routers: ${buyName} -> ${sellName}`
        );

        console.log(
          `Loan: ${formatUSDC(amountIn)} USDC`
        );

        console.log(
          `Returned: ${formatUSDC(returnedUSDC)} USDC`
        );

        console.log(
          `Net profit: ${formatUSDC(netProfit)} USDC`
        );

        if (netProfit > MIN_PROFIT_USDC) {

          console.log("PROFITABLE TRADE FOUND: YES");

          await executeTestTransaction();

        } else {

          console.log("PROFITABLE TRADE FOUND: NO");

        }

      } catch (err) {

        // ignore failing paths

      }
    }
  }
}

/* =========================
   PROOF TRANSACTION
========================= */

async function executeTestTransaction() {

  console.log("Executing proof transaction...");

  const tx = await wallet.sendTransaction({

    to: wallet.address,

    value: 0,

    gasLimit: 21000,

    maxFeePerGas: ethers.parseUnits("80", "gwei"),

    maxPriorityFeePerGas: ethers.parseUnits("40", "gwei")

  });

  console.log("TX SENT:");
  console.log(tx.hash);

  const receipt = await tx.wait();

  console.log("TX CONFIRMED");

  console.log(
    `https://polygonscan.com/tx/${tx.hash}`
  );

  console.log("Proof transaction complete");

}

/* =========================
   BOT LOOP
========================= */

async function startBot() {

  console.log("ARB BOT STARTED");

  console.log("RPC:", RPC_URL);

  console.log("Wallet:", wallet.address);

  const balance = await provider.getBalance(wallet.address);

  console.log(
    "MATIC balance:",
    ethers.formatEther(balance)
  );

  console.log("------------------------------------------------");

  const tokens = Object.values(TOKENS);

  while (true) {

    for (const token of tokens) {

      if (token === TOKENS.USDC) continue;

      await simulateArbitrage(token);

    }

    await new Promise(r =>
      setTimeout(r, SCAN_INTERVAL_MS)
    );

  }
}

startBot();
