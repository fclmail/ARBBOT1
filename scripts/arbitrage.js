import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

// ✅ Free working Polygon RPC (no API key required)
const RPC_POLYGON = "https://1rpc.io/matic";

// Try loading private key
let WALLET_PRIVATE_KEY = (process.env.OWNER_PRIVATE_KEY || "").trim();

// If missing, run in read-only mode instead of crashing
const HAS_PRIVATE_KEY = WALLET_PRIVATE_KEY.length > 0;

if (!HAS_PRIVATE_KEY) {
  console.log("⚠️ OWNER_PRIVATE_KEY missing — running in SCAN-ONLY mode");
}

/* ================= SETTINGS ================= */

const FIXED_TOTAL_USDC = .45;
const MIN_EXPECTED_PROFIT = 0.00001;
const DEADLINE_SECONDS = 45;
const SCAN_INTERVAL_MS = 8000;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);

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

/* ================= HELPERS ================= */

// ✅ FIXED quote function to catch reverts safely
async function quote(routerAddr, amountIn, path) {
  try {
    if (path.length < 2) return null; // invalid path
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    if (!amounts || amounts.length === 0) return null;
    return amounts[amounts.length - 1];
  } catch (err) {
    // log short and continue
    console.log(
      "⚠️ Quote failed for path:",
      path.map((t) => t.slice(0, 6) + "..."),
      "|",
      err.shortMessage || err.message || err
    );
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

/* ================= HYBRID ARBITRAGE ================= */

async function tryHybridArb(buyRouter, sellRouter, tokenAddr) {

  // ✅ Hardcoded Polygon USDC
  const usdcAddr = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

  const vaultBalanceRaw = await getVaultBalance(usdcAddr);
  const vaultBalance = Number(ethers.formatUnits(vaultBalanceRaw, 6));

  const tradeAmount = ethers.parseUnits(FIXED_TOTAL_USDC.toString(), 6);

  const pathToToken = [usdcAddr, tokenAddr];
  const pathToUSDC = [tokenAddr, usdcAddr];

  const expectedBuy = await quote(buyRouter, tradeAmount, pathToToken);
  if (!expectedBuy) return;

  const expectedSell = await quote(sellRouter, expectedBuy, pathToUSDC);
  if (!expectedSell) return;

  const finalOut = Number(ethers.formatUnits(expectedSell, 6));
  const estimatedProfit = finalOut - FIXED_TOTAL_USDC;

  if (estimatedProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`🔥 HYBRID PROFIT FOUND: ${estimatedProfit.toFixed(2)} USDC`);

  if (!HAS_PRIVATE_KEY) {
    console.log("🛑 Skipping execution (no private key)");
    return;
  }

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const tx = await vault.executeFlashArbitrage(
    buyRouter,
    sellRouter,
    tradeAmount,
    pathToToken,
    pathToUSDC,
    deadline
  );

  console.log(`⛓ TX SENT: ${tx.hash}`);
  await tx.wait();
  console.log(`✅ HYBRID FLASH EXECUTED`);
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
