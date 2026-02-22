import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const WALLET_PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
const HAS_PRIVATE_KEY = WALLET_PRIVATE_KEY.length > 0;

if (!HAS_PRIVATE_KEY) {
  console.log("⚠️ PRIVATE_KEY missing — running in SCAN-ONLY mode");
}

/* ================= SETTINGS ================= */

const FIXED_TOTAL_USDC = 10;
const MIN_EXPECTED_PROFIT = 0.00001;
const DEADLINE_SECONDS = 45;
const SCAN_INTERVAL_MS = 8000;
const GAS_LIMIT = 1_200_000;

/* ================= PROVIDER (FIXED) ================= */

const RPC_ENDPOINTS = [
  "https://polygon-rpc.com",
  "https://rpc-mainnet.maticvigil.com"
];

// Real providers (NO proxy)
const providers = RPC_ENDPOINTS.map(
  url => new ethers.JsonRpcProvider(url, 137)
);

// Proper ethers v6 fallback provider
const provider = new ethers.FallbackProvider(
  providers.map(p => ({
    provider: p,
    priority: 1,
    weight: 1,
    stallTimeout: 2000
  }))
);

let wallet = null;
if (HAS_PRIVATE_KEY) {
  wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
}

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  "function executeFlashArbitrage(address,address,uint256,address[],address[],uint256) external"
];

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  vaultAbi,
  HAS_PRIVATE_KEY ? wallet : provider
);

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

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= HELPERS ================= */

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

async function getVaultBalance() {
  try {
    const usdc = new ethers.Contract(
      USDC,
      ["function balanceOf(address) view returns(uint256)"],
      provider
    );

    const bal = await usdc.balanceOf(VAULT_ADDRESS);
    return bal;
  } catch (err) {
    console.error("❌ Vault balance error:", err?.reason || err?.message || err);
    return null;
  }
}

async function estimateGasCost() {
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("40", "gwei");
    return gasPrice * BigInt(GAS_LIMIT);
  } catch {
    return ethers.parseUnits("0.02", "ether");
  }
}

/* ================= ARBITRAGE ================= */

async function tryHybridArb(buyRouter, sellRouter, tokenAddr) {
  const vaultBalanceRaw = await getVaultBalance();
  if (!vaultBalanceRaw) return;

  const tradeAmount = ethers.parseUnits(FIXED_TOTAL_USDC.toString(), 6);

  const pathToToken = [USDC, tokenAddr];
  const pathToUSDC = [tokenAddr, USDC];

  const expectedBuy = await quote(buyRouter, tradeAmount, pathToToken);
  if (!expectedBuy) return;

  const expectedSell = await quote(sellRouter, expectedBuy, pathToUSDC);
  if (!expectedSell) return;

  const finalOut = Number(ethers.formatUnits(expectedSell, 6));
  const estimatedProfit = finalOut - FIXED_TOTAL_USDC;

  if (estimatedProfit <= 0) return;

  // Gas-aware filter
  const estimatedGasCost = await estimateGasCost();
  const gasCostUSDC = Number(ethers.formatUnits(estimatedGasCost, 18)) * 3000; // rough MATIC->USD

  if (estimatedProfit <= gasCostUSDC) return;
  if (estimatedProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`🔥 PROFIT: ${estimatedProfit.toFixed(6)} USDC`);

  if (!HAS_PRIVATE_KEY) return;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {
    const tx = await vault.executeFlashArbitrage(
      buyRouter,
      sellRouter,
      tradeAmount,
      pathToToken,
      pathToUSDC,
      deadline,
      {
        gasLimit: GAS_LIMIT,
        nonce: await wallet.getNonce()
      }
    );

    console.log(`⛓ TX SENT: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ FLASH EXECUTED`);
  } catch (err) {
    console.error("❌ Execution error:", err?.reason || err?.message || err);
  }
}

/* ================= SCAN LOOP ================= */

async function scan() {
  console.log(`\n🔍 Scan @ ${new Date().toISOString()}`);

  const jobs = [];

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          jobs.push(tryHybridArb(buy, sell, token));
        }
      }
    }
  }

  await Promise.all(jobs);
}

console.log("🚀 Hybrid Arbitrage Bot Started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
