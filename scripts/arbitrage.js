import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON = process.env.RPC_POLYGON;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY || !/^0x[a-fA-F0-9]{64}$/.test(PRIVATE_KEY)) {
  throw new Error("Invalid or missing private key. Check GitHub Secrets.");
}

/* ================= SETTINGS ================= */

const FLASH_AMOUNT = 10000;
const SCAN_INTERVAL = 10000;
const FLASH_FEE_BPS = 9;
const DEADLINE = 60;

const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const vaultAbi = [
  "function executeFlashArbitrage(address buyRouter,address sellRouter,uint256 amount,address[] calldata buyPath,address[] calldata sellPath,uint256 deadline)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

/* ================= TOKENS ================= */

const TOKENS = {
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ROUTER ABI ================= */

const routerAbi = [
  "function getAmountsOut(uint amountIn,address[] calldata path) view returns (uint[] memory)"
];

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ================= SIMULATION ================= */

async function simulate(buyRouter, sellRouter, token) {

  const buy = new ethers.Contract(buyRouter, routerAbi, provider);
  const sell = new ethers.Contract(sellRouter, routerAbi, provider);

  const loanAmount = ethers.parseUnits(FLASH_AMOUNT.toString(), 6);

  try {

    console.log("------------------------------------------------");
    console.log("Simulation started");
    console.log("Token:", token);
    console.log("Loan:", FLASH_AMOUNT, "USDC");

    const buyAmounts = await buy.getAmountsOut(
      loanAmount,
      [USDC, token]
    );

    const tokenAmount = buyAmounts[1];

    const sellAmounts = await sell.getAmountsOut(
      tokenAmount,
      [token, USDC]
    );

    const usdcBack = sellAmounts[1];

    const fee = (loanAmount * BigInt(FLASH_FEE_BPS)) / BigInt(10000);

    const profit = usdcBack - loanAmount - fee;

    console.log("Returned USDC:", ethers.formatUnits(usdcBack, 6));
    console.log("Flash loan fee:", ethers.formatUnits(fee, 6));

    const gasEstimate = ethers.parseUnits("0.4", 6);
    const net = profit - gasEstimate;

    console.log("Gas estimate:", ethers.formatUnits(gasEstimate, 6));
    console.log("Net profit:", ethers.formatUnits(net, 6));

    return {
      profit: net,
      loanAmount
    };

  } catch (err) {

    console.log("Simulation failed");

    return {
      profit: BigInt(0),
      loanAmount
    };
  }
}

/* ================= EXECUTION ================= */

async function executeArbitrage(buyRouter, sellRouter, token, loanAmount) {

  try {

    console.log("Executing flash arbitrage...");

    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      loanAmount,
      [USDC, token],
      [token, USDC],
      Math.floor(Date.now() / 1000) + DEADLINE
    );

    console.log("Transaction sent:", tx.hash);

    const receipt = await tx.wait();

    console.log("Transaction confirmed");
    console.log("Gas used:", receipt.gasUsed.toString());

    const gasPrice = receipt.gasPrice || 0n;

    const gasCost = receipt.gasUsed * gasPrice;

    console.log("Gas cost (wei):", gasCost.toString());

    console.log("Profit deposited to vault");

  } catch (err) {

    console.log("Execution failed:", err.shortMessage || err.message);
  }
}

/* ================= SCANNER ================= */

async function scan() {

  console.log("");
  console.log("===== NEW SCAN =====");
  console.log("Time:", new Date().toISOString());

  for (const token of Object.values(TOKENS)) {

    for (const buy of Object.values(ROUTERS)) {

      for (const sell of Object.values(ROUTERS)) {

        if (buy === sell) continue;

        const result = await simulate(buy, sell, token);

        if (result.profit > 0n) {

          console.log("PROFITABLE TRADE FOUND");

          await executeArbitrage(
            buy,
            sell,
            token,
            result.loanAmount
          );
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

async function startBot() {

  console.log("=====================================");
  console.log("FLASH ARBITRAGE BOT STARTED");
  console.log("Wallet:", wallet.address);
  console.log("Loan size:", FLASH_AMOUNT, "USDC");
  console.log("Scan interval:", SCAN_INTERVAL / 1000, "seconds");
  console.log("=====================================");

  while (true) {

    try {

      await scan();

    } catch (err) {

      console.log("Scan error:", err.message);
    }

    await sleep(SCAN_INTERVAL);
  }
}

startBot();
