/**
 * 🔥 FULL ARBITRAGE BOT - Ethers v6 + bigint
 * - DRY_RUN = false (LIVE TRADING ENABLED)
 * - Trade Amount: 0.05 USDC
 * - Vault Balance: 0.07 USDC
 */

import { ethers, Wallet } from "ethers";

// ---------- CONFIG ----------
const DRY_RUN = false;
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// ---------- HARD-CODED CONTRACT ----------
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// ---------- SETTINGS ----------
const TRADE_AMOUNT_USDC = 0.05; // trade size in USDC
const MIN_EXPECTED_PROFIT_USDC = 0.0001; // minimum profit to execute trade
const SLIPPAGE_PCT = 0.3; // slippage allowance %

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TOKENS = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 }
};

// ---------- PROVIDER & WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------
const arbAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns (address)",
  "function owner() view returns (address)"
];
const arbContract = DRY_RUN
  ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
  : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];
let usdcContract;

// ---------- INIT ----------
async function init() {
  const usdcAddr = await arbContract.USDC();
  usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
  const owner = await arbContract.owner();
  console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
  console.log("👤 Contract Owner:", owner);
  console.log("💱 USDC token address:", usdcAddr);
}

// ---------- HELPERS ----------
function toUnits(amount, decimals) {
  return BigInt(Math.floor(amount * 10 ** decimals));
}
function fromUnits(amountBN, decimals) {
  return Number(amountBN) / 10 ** decimals;
}

async function getAmountsOutRaw(routerAddr, path, amountInUnits) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  return await router.getAmountsOut(amountInUnits, path);
}

async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC) {
  const usdcAddr = await arbContract.USDC();
  const amountInUnits = toUnits(amountUSDC, TOKENS.USDC.decimals);
  let buyAmounts = await getAmountsOutRaw(buyRouter, [usdcAddr, tokenObj.address], amountInUnits);
  const tokenAmount = buyAmounts[buyAmounts.length - 1];
  let sellAmounts = await getAmountsOutRaw(sellRouter, [tokenObj.address, usdcAddr], tokenAmount);
  const expectedUSDCOut = fromUnits(sellAmounts[sellAmounts.length - 1], TOKENS.USDC.decimals);
  const safetyMultiplier = 1 - (SLIPPAGE_PCT / 100) - 0.0025;
  return toUnits(expectedUSDCOut * safetyMultiplier, TOKENS.USDC.decimals);
}

async function executeTrade(buyRouter, sellRouter, tokenObj, amountUSDC) {
  const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
  const before = fromUnits(beforeBal, TOKENS.USDC.decimals);
  const minReturnBN = await computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDC);
  const minReturnUSD = fromUnits(minReturnBN, TOKENS.USDC.decimals);

  if (minReturnUSD - amountUSDC < MIN_EXPECTED_PROFIT_USDC) {
    console.log(`💤 Trade skipped: insufficient expected profit (${(minReturnUSD - amountUSDC).toFixed(6)} USDC)`);
    return;
  }

  if (DRY_RUN) {
    console.log(`🧪 DRY_RUN: would trade ${amountUSDC} USDC for ${tokenObj.address} | minReturn ${minReturnUSD} USDC`);
    return;
  }

  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenObj.address, toUnits(amountUSDC, TOKENS.USDC.decimals), minReturnBN
    );
    console.log(`🚀 Tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
      const after = fromUnits(afterBal, TOKENS.USDC.decimals);
      console.log(`✅ Trade success. Profit: ${(after - before).toFixed(6)} USDC`);
    } else {
      console.log("❌ Trade failed or reverted");
    }
  } catch (err) {
    console.warn("❌ Trade execution error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
async function scanOnce() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(TOKENS)) {
    for (const [buyName, buyRouter] of Object.entries(ROUTERS)) {
      for (const [sellName, sellRouter] of Object.entries(ROUTERS)) {
        if (buyRouter === sellRouter) continue; // skip identical addresses
        try {
          await executeTrade(buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
        } catch (e) {
          console.warn("⚠️ Scan error:", e.message);
        }
      }
    }
  }
}

// ---------- MAIN LOOP ----------
(async () => {
  await init();
  console.log(`🚀 Arbitrage bot started (DRY_RUN=${DRY_RUN})`);
  while (true) {
    await scanOnce();
    await new Promise(r => setTimeout(r, 5000)); // scan every 5s
  }
})();
