// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const RPC_A = process.env.RPC_A;
const RPC_B = process.env.RPC_B;
const providerA = new ethers.JsonRpcProvider(RPC_A);
const providerB = new ethers.JsonRpcProvider(RPC_B);

const USDC_ADDRESS = process.env.USDC_ADDRESS;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
const ROUTER_A = process.env.ROUTER_A;
const ROUTER_B = process.env.ROUTER_B;

// Example ABI fragments
import ERC20_ABI from "../abi/erc20.json" assert { type: "json" };
import ROUTER_ABI from "../abi/router.json" assert { type: "json" };

const usdcA = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, providerA);
const tokenA = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, providerA);
const routerA = new ethers.Contract(ROUTER_A, ROUTER_ABI, providerA);
const routerB = new ethers.Contract(ROUTER_B, ROUTER_ABI, providerB);

let USDC_DECIMALS = 6;
let TOKEN_DECIMALS = 18;
let MIN_PROFIT_UNITS;
let amountInUSDCBase;

async function initDecimals() {
  USDC_DECIMALS = await usdcA.decimals();
  TOKEN_DECIMALS = await tokenA.decimals();

  // Clamp and normalize constants
  const amountInUSDCStr = (process.env.AMOUNT_USDC || "10").toString();
  const minProfitStr = (process.env.MIN_PROFIT_USDC || "0.000001").toString();

  // Avoid scientific notation (1e-7 → 0.0000001)
  const safeAmountStr = Number(amountInUSDCStr).toFixed(USDC_DECIMALS);
  const safeMinProfitStr = Number(minProfitStr).toFixed(USDC_DECIMALS);

  amountInUSDCBase = ethers.parseUnits(safeAmountStr, USDC_DECIMALS);
  MIN_PROFIT_UNITS = ethers.parseUnits(safeMinProfitStr, USDC_DECIMALS);

  console.log(
    `🔧 Decimals initialized: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`
  );
  console.log(`🔧 amountInUSDCBase=${amountInUSDCBase.toString()}`);
  console.log(`🔧 MIN_PROFIT_UNITS=${MIN_PROFIT_UNITS.toString()}`);
}

async function getQuote(router, fromToken, toToken, amountIn, providerLabel) {
  try {
    const amounts = await router.getAmountsOut(amountIn, [fromToken, toToken]);
    return amounts[1];
  } catch (err) {
    console.error(`❌ Quote error on ${providerLabel}:`, err.message);
    return 0n;
  }
}

function toHuman(baseValue, decimals) {
  // Safe formatting for possibly negative BigInt
  const sign = baseValue < 0n ? "-" : "";
  const abs = baseValue < 0n ? -baseValue : baseValue;
  const s = ethers.formatUnits(abs, decimals);
  return `${sign}${s}`;
}

async function runLoop() {
  console.log(`🚀 Starting bidirectional live arbitrage scanner\n`);

  const subscription = providerA.on("block", async (blockNumber) => {
    console.log(`[#${blockNumber}] 🔍 Block ${blockNumber}: scanning both directions...`);

    // --- Direction A→B ---
    const buyOutA = await getQuote(routerA, USDC_ADDRESS, TOKEN_ADDRESS, amountInUSDCBase, "A→B-buy");
    const sellOutB = await getQuote(routerB, TOKEN_ADDRESS, USDC_ADDRESS, buyOutA, "A→B-sell");

    const profitA = sellOutB - amountInUSDCBase;
    console.log(`[A→B] 💱 Buy → ${ethers.formatUnits(buyOutA, TOKEN_DECIMALS)} TOKEN`);
    console.log(`[A→B] 💲 Sell → ${ethers.formatUnits(sellOutB, USDC_DECIMALS)} USDC`);
    console.log(`[A→B] 🧮 Profit = ${toHuman(profitA, USDC_DECIMALS)} USDC`);

    if (profitA >= MIN_PROFIT_UNITS) {
      console.log(`[A→B] ✅ Profitable! Executing trade...`);
      // await executeArbitrage("A→B", amountInUSDCBase);
    } else {
      console.log(`[A→B] 🚫 Not profitable (below threshold).`);
    }

    // --- Direction B→A ---
    const buyOutB = await getQuote(routerB, USDC_ADDRESS, TOKEN_ADDRESS, amountInUSDCBase, "B→A-buy");
    const sellOutA = await getQuote(routerA, TOKEN_ADDRESS, USDC_ADDRESS, buyOutB, "B→A-sell");

    const profitB = sellOutA - amountInUSDCBase;
    console.log(`[B→A] 💱 Buy → ${ethers.formatUnits(buyOutB, TOKEN_DECIMALS)} TOKEN`);
    console.log(`[B→A] 💲 Sell → ${ethers.formatUnits(sellOutA, USDC_DECIMALS)} USDC`);
    console.log(`[B→A] 🧮 Profit = ${toHuman(profitB, USDC_DECIMALS)} USDC`);

    if (profitB >= MIN_PROFIT_UNITS) {
      console.log(`[B→A] ✅ Profitable! Executing trade...`);
      // await executeArbitrage("B→A", amountInUSDCBase);
    } else {
      console.log(`[B→A] 🚫 Not profitable (below threshold).`);
    }
  });
}

async function main() {
  try {
    await initDecimals();
    await runLoop();
  } catch (err) {
    console.error("❌ Fatal error in main loop:", err);
    process.exit(1);
  }
}

main();

   
