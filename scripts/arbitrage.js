import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

// ✅ HARDCODED RPC (UNCHANGED)
const RPC_POLYGON = "https://rpc.ankr.com/polygon";

// ✅ FIXED: use PRIVATE_KEY (matches GitHub secret)
const WALLET_PRIVATE_KEY =
  (process.env.PRIVATE_KEY || "").trim();

if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= SETTINGS ================= */

const FIXED_TOTAL_USDC = 10000;
const MIN_EXPECTED_PROFIT = 5;
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
  } catch {
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

  const usdcAddr = await vault.usdc();
  const vaultBalanceRaw = await getVaultBalance(usdcAddr);
  const vaultBalance = Number(ethers.formatUnits(vaultBalanceRaw, 6));

  const totalTarget = FIXED_TOTAL_USDC;

  let flashNeeded = totalTarget - vaultBalance;
  if (flashNeeded < 0) flashNeeded = 0;

  // ✅ FIX: true flash amount
  const flashAmount = ethers.parseUnits(
    flashNeeded.toFixed(6),
    6
  );

  if (flashAmount === 0n) {
    console.log("⚠ Vault has enough capital. No flash needed.");
    return;
  }

  const tradeAmount = ethers.parseUnits(totalTarget.toString(), 6);

  const pathToToken = [usdcAddr, tokenAddr];
  const pathToUSDC = [tokenAddr, usdcAddr];

  const expectedBuy = await quote(buyRouter, tradeAmount, pathToToken);
  if (!expectedBuy) return;

  const expectedSell = await quote(sellRouter, expectedBuy, pathToUSDC);
  if (!expectedSell) return;

  const finalOut = Number(ethers.formatUnits(expectedSell, 6));

  // ✅ FIX: account for Aave premium (0.09%)
  const premium = flashNeeded * 0.0009;
  const estimatedProfit = finalOut - totalTarget - premium;

  if (estimatedProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`🔥 HYBRID PROFIT FOUND: ${estimatedProfit.toFixed(2)} USDC`);
  console.log(`🏦 Vault Balance: ${vaultBalance.toFixed(2)} USDC`);
  console.log(`⚡ Flash Needed: ${flashNeeded.toFixed(2)} USDC`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  // ✅ FIX: simulation before sending tx
  try {
    await vault.executeFlashArbitrage.staticCall(
      buyRouter,
      sellRouter,
      flashAmount,
      pathToToken,
      pathToUSDC,
      deadline
    );
    console.log("🧪 Flash simulation passed");
  } catch (err) {
    console.log("❌ Flash simulation failed:", err.shortMessage || err.reason || err);
    return;
  }

  const tx = await vault.executeFlashArbitrage(
    buyRouter,
    sellRouter,
    flashAmount,
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
