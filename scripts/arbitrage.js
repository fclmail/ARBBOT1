import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON = "https://polygon-bor-rpc.publicnode.com";
const WALLET_PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= SETTINGS ================= */
const FIXED_TOTAL_USDC = 0.29;
const MIN_EXPECTED_PROFIT = 0.000001;
const DEADLINE_SECONDS = 45;
const SCAN_INTERVAL_MS = 18000;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";
const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256) external",
  "function usdc() view returns(address)"
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
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

/* ================= HELPERS ================= */
async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch (err) {
    console.warn(`❌ Quote failed for router ${routerAddr}:`, err.message || err);
    return null;
  }
}

async function getVaultBalance(usdcAddr) {
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );
  return usdc.balanceOf(VAULT_ADDRESS);
}

/* ================= PATH BUILDERS ================= */
function buildBuyPaths(usdcAddr, tokenAddr) {
  return [
    [usdcAddr, tokenAddr],
    [usdcAddr, TOKENS.WMATIC, tokenAddr],
    [usdcAddr, TOKENS.WETH, tokenAddr],
    [usdcAddr, TOKENS.USDT, tokenAddr]
  ];
}

function buildSellPaths(usdcAddr, tokenAddr) {
  return [
    [tokenAddr, usdcAddr],
    [tokenAddr, TOKENS.WMATIC, usdcAddr],
    [tokenAddr, TOKENS.WETH, usdcAddr],
    [tokenAddr, TOKENS.USDT, usdcAddr]
  ];
}

/* ================= HYBRID ARBITRAGE ================= */
async function tryHybridArb(buyRouter, sellRouter, tokenAddr) {
  const usdcAddr = await vault.usdc();
  const vaultBalanceRaw = await getVaultBalance(usdcAddr);
  const vaultBalance = Number(ethers.formatUnits(vaultBalanceRaw, 6));

  const totalTarget = Math.max(FIXED_TOTAL_USDC, vaultBalance);
  let flashNeeded = totalTarget - vaultBalance;
  if (flashNeeded < 0) flashNeeded = 0;

  // Flash optional: use flash if needed, else vault balance
  const flashAmount = ethers.parseUnits(flashNeeded.toFixed(6), 6);
  const amountToUse = flashAmount > 0n
    ? flashAmount
    : ethers.parseUnits(totalTarget.toString(), 6);

  const buyPaths = buildBuyPaths(usdcAddr, tokenAddr);
  const sellPaths = buildSellPaths(usdcAddr, tokenAddr);

  let bestBuyOut, bestBuyPath, bestSellOut, bestSellPath;

  // Find best buy path
  for (const p of buyPaths) {
    const out = await quote(buyRouter, amountToUse, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyOut) return;

  // Find best sell path
  for (const p of sellPaths) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }
  if (!bestSellOut) return;

  const finalOut = Number(ethers.formatUnits(bestSellOut, 6));
  const premium = flashNeeded * 0.0009;
  const estimatedProfit = finalOut - totalTarget - premium;

  if (estimatedProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`🔥 HYBRID PROFIT FOUND: ${estimatedProfit.toFixed(6)} USDC`);
  console.log(`🏦 Vault Balance: ${vaultBalance.toFixed(6)} USDC`);
  console.log(`⚡ Flash Needed: ${flashNeeded.toFixed(6)} USDC`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  // Simulation
  try {
    await vault.executeFlashArbitrage.staticCall(
      buyRouter,
      sellRouter,
      amountToUse,
      bestBuyPath,
      bestSellPath,
      deadline
    );
    console.log("🧪 Flash simulation passed");
  } catch (err) {
    console.log("❌ Flash simulation failed:", err.shortMessage || err.reason || err);
    return;
  }

  // Execute trade
  try {
    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      amountToUse,
      bestBuyPath,
      bestSellPath,
      deadline
    );
    console.log(`⛓ TX SENT: ${tx.hash}`);
    await tx.wait();
    console.log("✅ HYBRID FLASH EXECUTED");
  } catch (err) {
    console.log("❌ Execution failed:", err);
  }
}

/* ================= SCAN LOOP ================= */
async function scan() {
  console.log(`\n🔍 Scan @ ${new Date().toISOString()}`);
  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await tryHybridArb(buy, sell, token);
        }
      }
    }
  }
}

console.log("🚀 Hybrid Arbitrage Bot Started");
setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
