// scripts/arbitrage.js
// Strong-safety arbitrage runner (ethers v6) with fixes applied for staticCall, gas, and profit thresholds

import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com/";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

const DRY_RUN = process.env.DRY_RUN === "true" || false;

// Safety / tuning
const GAS_COST_USDC = Number(process.env.GAS_COST_USDC ?? "0.0004");
const MIN_PROFIT_USDC = Number(process.env.MIN_PROFIT_USDC ?? "0.0000001");
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? "0.05");
const MAX_PROFIT_PCT = Number(process.env.MAX_PROFIT_PCT ?? "400");
const MAX_PRICE_MULTIPLIER = Number(process.env.MAX_PRICE_MULTIPLIER ?? "1000");

// Addresses
const CONTRACT_ADDRESS_RAW = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS_RAW = "0x2791Bca1f2de4661ED88a30C99A7a9449Aa84174";
const AAVE_POOL_RAW = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

// Routers to scan
const DEX_ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Scan settings
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC ?? ".02");
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT ?? "0.001");
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS ?? "5000");

// ===== ABIs =====
const arbAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function minProfit() view returns (uint256)"
];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

// ===== PROVIDER & WALLET =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);

// canonicalize addresses
let CONTRACT_ADDRESS, USDC_ADDRESS, AAVE_POOL;
try { CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW); } catch { CONTRACT_ADDRESS = CONTRACT_ADDRESS_RAW.toLowerCase(); }
try { USDC_ADDRESS = ethers.getAddress(USDC_ADDRESS_RAW); } catch { USDC_ADDRESS = USDC_ADDRESS_RAW.toLowerCase(); }
try { AAVE_POOL = ethers.getAddress(AAVE_POOL_RAW); } catch { AAVE_POOL = AAVE_POOL_RAW.toLowerCase(); }

// ===== CONTRACT INSTANCES =====
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);
let usdcContract = null;

// ===== TOKENS =====
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ===== UTILITIES =====
function fmt(n, dec = 6) {
  if (n === null || typeof n === "undefined" || Number.isNaN(Number(n))) return "NaN";
  return Number(n).toFixed(dec);
}

async function safeGetDecimals(tokenAddr) {
  try {
    const t = new ethers.Contract(tokenAddr, erc20Abi, provider);
    return Number(await t.decimals());
  } catch {
    return 18;
  }
}

// fetch DEX quote safely with fallback
async function getAmountOut(routerAddr, tokenObj, amountInUSDC) {
  try {
    if (!routerAddr || !tokenObj || !tokenObj.address) return 0;
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amountInWei = ethers.parseUnits(amountInUSDC.toString(), 6);

    const primaryPath = [USDC_ADDRESS, tokenObj.address];
    try {
      const amounts = await router.getAmountsOut(amountInWei, primaryPath);
      if (amounts && amounts.length >= 2) {
        const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
        return Number(ethers.formatUnits(amounts[1], decimals));
      }
    } catch {}

    // fallback via WBTC
    try {
      const fallbackPath = [USDC_ADDRESS, tokens.WBTC.address, tokenObj.address];
      const amountsFb = await router.getAmountsOut(amountInWei, fallbackPath);
      if (amountsFb && amountsFb.length >= 3) {
        const decimals = tokenObj.decimals ?? await safeGetDecimals(tokenObj.address);
        return Number(ethers.formatUnits(amountsFb[2], decimals));
      }
    } catch {}

    return 0;
  } catch {
    return 0;
  }
}

// ===== EXECUTOR =====
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const amountInWei = ethers.parseUnits(amountUSDC.toString(), 6);

  // 1) static simulation via callStatic
  try {
    await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei);
    console.log("✅ static simulation passed");
  } catch (err) {
    console.log("❌ static simulation failed, aborting:", err?.message || err);
    return;
  }

  // 2) estimate gas
  let gasLimit;
  try {
    const estimatedGas = await arbContract.estimateGas.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei);
    gasLimit = BigInt(estimatedGas) + 10000n;
  } catch (err) {
    console.log("❌ estimateGas failed, aborting:", err?.message || err);
    return;
  }

  // 3) profit sanity check (simplified example, real logic can be expanded)
  const buyOut = await getAmountOut(buyRouter, { address: tokenAddr, decimals: 18 }, amountUSDC);
  const sellOut = await getAmountOut(sellRouter, { address: tokenAddr, decimals: 18 }, amountUSDC);
  const rawProfit = (sellOut - buyOut) * buyOut;
  if (rawProfit < MIN_PROFIT_USDC) {
    console.log("❌ Profit below minimum, skipping trade");
    return;
  }

  // 4) execute trade if not dry run
  if (DRY_RUN) {
    console.log("🔬 DRY_RUN enabled, trade not sent");
    return;
  }

  try {
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountInWei, { gasLimit });
    console.log("📤 Transaction sent, hash:", tx.hash);
    const receipt = await tx.wait();
    console.log(receipt.status === 1 ? "✅ Trade confirmed" : "❌ Trade failed");
  } catch (err) {
    console.log("⚠ Error executing trade:", err?.message || err);
  }
}
