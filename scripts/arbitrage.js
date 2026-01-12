// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – VAULT VERSION (SAFE + BIGNUMBER PRECHECK + AUTO-APPROVE USDC + FULL LOGS)
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* ===================== GLOBAL SAFETY NET ===================== */
process.on("unhandledRejection", (reason) => {
  console.log("⚠️ Unhandled rejection caught:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.log("⚠️ Uncaught exception caught:", err.message);
});
/* ============================================================= */

// ----------------- CONFIG -----------------
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) console.log("❌ Missing PRIVATE KEY");

const DRY_RUN = false;
const MIN_TRADE_USDC = 0.05;  // minimum trade size in USDC
const MIN_EXPECTED_PROFIT = 0.00001;
const MIN_PROFIT_PCT = 1.0;
const SLIPPAGE_PCT = 0.05;
const MAX_PROFIT_PCT = 550;

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ----------------- RPC ROTATION (POLYGON SAFE) -----------------
const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon-public.nodies.app",
  "https://polygon.drpc.org"
];

let rpcIndex = 0;
function newProvider() {
  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return new ethers.JsonRpcProvider(url, { name: "matic", chainId: 137 });
}
let provider = newProvider();
let wallet = new Wallet(PRIVATE_KEY, provider);

// Hard failover wrapper
async function rpc(fn) {
  try {
    return await fn(provider);
  } catch (e) {
    if (e.code === "NETWORK_ERROR" || e.message?.includes("network")) {
      console.log("🔁 RPC failed, rotating...");
      provider = newProvider();
      wallet = new Wallet(PRIVATE_KEY, provider);
      return fn(provider);
    }
    throw e;
  }
}

// ----------------- VAULT -----------------
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function approveRouter(address router,address token) external",
  "function paused() view returns (bool)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)"
];

// ----------------- TOKENS -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ----------------- ROUTERS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ----------------- BASE FALLBACKS -----------------
const BASES = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
];

// ----------------- HELPERS -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sanePct(p) {
  return Number.isFinite(p) && p > -1000 && p < MAX_PROFIT_PCT;
}

// Get vault USDC address
async function vaultUSDC() {
  try { return await rpc(() => vault.USDC()); }
  catch { return BASES[0]; }
}

// Get vault USDC balance as BigNumber
async function vaultBalanceBN() {
  const usdc = new ethers.Contract(await vaultUSDC(), erc20Abi, provider);
  return await rpc(() => usdc.balanceOf(VAULT_ADDRESS)); // returns BigNumber
}

// Fetch token quote
async function quote(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint,address[]) view returns(uint[])"],
    provider
  );
  const amt = ethers.parseUnits(amountUSDC.toString(), 6);
  for (const base of BASES) {
    try {
      const a = await rpc(() => router.getAmountsOut(amt, [base, token.address]));
      return Number(ethers.formatUnits(a[1], token.decimals));
    } catch {}
  }
  return null;
}

// ----------------- AUTO APPROVE -----------------
async function ensureApprovals() {
  console.log(`${colors.cyan}🔑 Checking router approvals...${colors.reset}`);

  // Approve all tokens for all routers
  for (const token of Object.values(tokens)) {
    const tokenContract = new ethers.Contract(token.address, erc20Abi, wallet);
    for (const router of Object.values(routers)) {
      try {
        const allowance = await rpc(() => tokenContract.allowance(VAULT_ADDRESS, router));
        if (allowance.gt(ethers.parseUnits("1000000", token.decimals))) continue;

        const tx = await rpc(() => vault.approveRouter(router, token.address));
        console.log(`${colors.green}✅ Approval sent for ${token.address} -> ${router}${colors.reset}`);
        await tx.wait();
      } catch (e) {
        console.log(`${colors.red}⚠️ Approval error: ${e.message}${colors.reset}`);
      }
      await sleep(200);
    }
  }

  // Approve USDC for all routers (buy leg)
  const usdcAddress = await vaultUSDC();
  const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, wallet);
  for (const router of Object.values(routers)) {
    try {
      const allowance = await rpc(() => usdcContract.allowance(VAULT_ADDRESS, router));
      if (allowance.gt(ethers.parseUnits("1000000", 6))) continue;

      const tx = await rpc(() => vault.approveRouter(router, usdcAddress));
      console.log(`${colors.green}✅ Approval sent for USDC -> ${router}${colors.reset}`);
      await tx.wait();
    } catch (e) {
      console.log(`${colors.red}⚠️ USDC approval error: ${e.message}${colors.reset}`);
    }
    await sleep(200);
  }
}

// ----------------- PRECHECK -----------------
async function checkArbConditions(vault, buyRouter, sellRouter, token, amountUSDC, minTokenOut, minUSDCOut, deadline, wallet) {
  const reasons = [];

  const paused = await vault.paused();
  if (paused) reasons.push("Vault is paused");

  if (amountUSDC <= 0) reasons.push("AmountInUSDC must be > 0");

  const usdcAddress = await vaultUSDC();
  const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, wallet.provider);

  // Use BigNumber for comparison
  const vaultBalRaw = await usdcContract.balanceOf(VAULT_ADDRESS); 
  const amountBN = ethers.parseUnits(amountUSDC.toString(), 6);
  if (vaultBalRaw.lt(amountBN)) reasons.push("Vault USDC balance insufficient");

  const allowanceUSDC = await usdcContract.allowance(VAULT_ADDRESS, buyRouter);
  if (allowanceUSDC.lt(amountBN)) reasons.push("Vault USDC not approved for buyRouter");

  const tokenContract = new ethers.Contract(token.address, erc20Abi, wallet.provider);
  const allowanceToken = await tokenContract.allowance(VAULT_ADDRESS, sellRouter);
  if (allowanceToken.lt(ethers.parseUnits(minTokenOut.toString(), token.decimals))) reasons.push("Vault token not approved for sellRouter");

  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now) reasons.push("Deadline is in the past");

  if (!ethers.isAddress(buyRouter)) reasons.push("buyRouter is invalid");
  if (!ethers.isAddress(sellRouter)) reasons.push("sellRouter is invalid");

  return { ok: reasons.length === 0, reasons };
}

// ----------------- EXECUTION -----------------
async function executeTrade(buyRouter, sellRouter, token, minTradeUSDC) {
  try {
    const vaultBalBN = await vaultBalanceBN();
    if (vaultBalBN.lt(ethers.parseUnits(minTradeUSDC.toString(), 6))) return;

    const vaultBal = Number(ethers.formatUnits(vaultBalBN, 6));
    const tradeAmount = Math.min(vaultBal, minTradeUSDC);

    console.log(`${colors.cyan}🏦 Vault Before: ${fmt(vaultBal)} USDC${colors.reset}`);

    const buyOut = await quote(buyRouter, token, tradeAmount);
    const sellOut = await quote(sellRouter, token, tradeAmount);
    if (!buyOut || !sellOut) return;

    const buyPrice = tradeAmount / buyOut;
    const sellPrice = tradeAmount / sellOut;
    const profit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const pct = (profit / buyPrice) * 100;

    if (!sanePct(pct) || profit < MIN_EXPECTED_PROFIT || pct < MIN_PROFIT_PCT) return;

    // Precheck before sending tx
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const { ok, reasons } = await checkArbConditions(vault, buyRouter, sellRouter, token, tradeAmount, buyOut*0.9995, sellOut*0.9995, deadline, wallet);
    if (!ok) {
      console.log(`${colors.red}⚠️ Precheck failed: ${reasons.join(", ")}${colors.reset}`);
      return;
    }

    console.log(`${colors.green}💰 Expected Profit: ${fmt(profit)} USDC (${fmt(pct)}%)${colors.reset}`);
    console.log(`${colors.cyan}📈 Buy: ${fmt(buyPrice)}, Sell: ${fmt(sellPrice)}${colors.reset}`);

    const tx = await rpc(() =>
      vault.executeArbitrage(
        buyRouter,
        sellRouter,
        token.address,
        ethers.parseUnits(tradeAmount.toString(), 6),
        Math.floor(buyOut * 0.9995),
        Math.floor(sellOut * 0.9995),
        deadline
      )
    );

    console.log(`${colors.green}🔁 TX SENT: ${tx.hash}${colors.reset}`);
    console.log("⏳ Waiting for confirmation...");

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) return;

    const afterBalBN = await vaultBalanceBN();
    const after = Number(ethers.formatUnits(afterBalBN, 6));
    console.log(`${colors.green}✅ Vault After: ${fmt(after)} USDC`);
    console.log(`REAL PROFIT: ${fmt(after - vaultBal)} USDC${colors.reset}`);

  } catch (err) {
    console.log(`${colors.red}⚠️ Trade error: ${err.message}${colors.reset}`);
  }
}

// ----------------- SCANNER -----------------
async function scan() {
  console.log("\n🔍 Scanning...");
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await executeTrade(buy, sell, token, MIN_TRADE_USDC);
          await sleep(800);
        }
      }
    }
  }
}

// ----------------- MAIN -----------------
(async () => {
  console.log(`${colors.cyan}🚀 Arb bot running${colors.reset}`);
  await ensureApprovals();

  while (true) {
    await scan();
    await sleep(8000);
  }
})();
