import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PK");

/* ================= CONFIG ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const contractAbi = [
  "function triggerFlashArbitrage((address routerBuy,address routerSell,address token) route,uint256 amountIn,uint256 minimumExpectedProfit)",
  "function startAaveFlashArbitrage(address asset,uint256 amount,(address routerBuy,address routerSell,address token) route,uint256 minProfit)",
  "function findBestFlashLoanSize(address pair,uint256 maxTestAmount) view returns(uint256,uint256)",
  "function getContractUSDCBalance() view returns(uint256)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

/* ================= MODE ================= */

const MODE = process.env.MODE || "HYBRID";

/* ================= ROUTE ================= */

function makeRoute(token) {
  return {
    routerBuy: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    routerSell: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
    token
  };
}

/* ================= MICRO SIGNAL ================= */

async function microDetect() {
  return {
    profit: ethers.parseUnits("0.0005", 6),
    token: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
  };
}

/* ================= CONTINUOUS PROFIT WEIGHTED SCALING ================= */

async function profitWeightedSize(pair, maxLoan) {

  const depth =
    await vault.findBestFlashLoanSize(pair, maxLoan);

  const size = BigInt(depth[0]);
  const profit = BigInt(depth[1]);

  // avoid division by zero
  if (size === 0n) return 0n;

  // profit density (efficiency curve)
  const efficiency =
    (profit * 1_000_000n) / size;

  let multiplier = 100n;

  if (efficiency > 2000n) multiplier = 300n;
  else if (efficiency > 1000n) multiplier = 200n;
  else if (efficiency > 500n) multiplier = 150n;

  const scaled =
    (size * multiplier) / 100n;

  return scaled < BigInt(maxLoan)
    ? scaled
    : BigInt(maxLoan);
}

/* ================= EXECUTION ================= */

async function execute(token, size) {

  const route = makeRoute(token);

  const balance =
    await vault.getContractUSDCBalance();

  const vaultBalance = BigInt(balance);

  /* -------- VAULT -------- */
  if (MODE === "VAULT") {

    const finalSize =
      size > vaultBalance ? vaultBalance : size;

    console.log("⚡ VAULT EXEC:", finalSize.toString());

    return await vault.triggerFlashArbitrage(
      route,
      finalSize,
      ethers.parseUnits("0.000001", 6)
    );
  }

  /* -------- FLASH -------- */
  if (MODE === "FLASH") {

    console.log("⚡ FLASH EXEC:", size.toString());

    return await vault.startAaveFlashArbitrage(
      USDC,
      size,
      route,
      ethers.parseUnits("0.000001", 6)
    );
  }

  /* -------- HYBRID -------- */
  if (MODE === "HYBRID") {

    if (size > vaultBalance) {

      console.log("⚡ HYBRID → FLASH");

      return await vault.startAaveFlashArbitrage(
        USDC,
        size,
        route,
        ethers.parseUnits("0.000001", 6)
      );
    }

    console.log("⚡ HYBRID → VAULT");

    return await vault.triggerFlashArbitrage(
      route,
      size,
      ethers.parseUnits("0.000001", 6)
    );
  }
}

/* ================= SCALE ENGINE ================= */

async function scaleEngine(token) {

  console.log("\n📊 MICRO SCAN START");

  const micro = await microDetect();

  console.log("MICRO PROFIT:", micro.profit.toString());

  const pair = "PAIR_ADDRESS_PLACEHOLDER";

  const maxLoan =
    ethers.parseUnits("100000", 6);

  const size =
    await profitWeightedSize(pair, maxLoan);

  console.log("🚀 FINAL CONTINUOUS SIZE:", size.toString());

  const tx = await execute(token, size);

  const receipt = await tx.wait();

  console.log("✅ CONFIRMED BLOCK:", receipt.blockNumber);
}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log("🚀 BOT STARTED MODE:", MODE);

  while (true) {

    try {

      const signal = await microDetect();

      if (signal.profit > ethers.parseUnits("0.0004", 6)) {

        await scaleEngine(signal.token);
      }

    } catch (e) {

      console.log("ERROR:", e.message);
    }
  }
}

main();
