import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

// ✅ HARDCODED RPC (UNCHANGED)
const RPC_POLYGON = "https://polygon-bor-rpc.publicnode.com";

// ✅ FIXED: use PRIVATE_KEY (matches GitHub secret)
const WALLET_PRIVATE_KEY =
  (process.env.PRIVATE_KEY || "").trim();

if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= SETTINGS ================= */

const FIXED_TOTAL_USDC = 0.20;
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
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external",
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
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= SIMULATION ================= */

async function vaultWillExecute(args) {
  console.log(`🧪 SIMULATION START`);
  try {
    await vault.executeFlashArbitrage.staticCall(...args);
    console.log(`🧪 SIMULATION PASSED`);
    return true;
  } catch (err) {
    console.log(`❌ SIMULATION FAILED:`, err.shortMessage || err.reason || err);
    return false;
  }
}

/* ================= PATH BUILDERS ================= */

function buildPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token],
    [usdc, TOKENS.USDT, token],
    [usdc, TOKENS.DAI, token]
  ];
}

function buildSellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc],
    [token, TOKENS.USDT, usdc],
    [token, TOKENS.DAI, usdc]
  ];
}

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

async function showSystemStatus() {
  const usdcAddr = await vault.usdc();
  const vaultBalanceRaw = await getVaultBalance(usdcAddr);
  const walletBalance = await provider.getBalance(wallet.address);

  console.log(`\n📊 SYSTEM STATUS`);
  console.log(`👛 Wallet: ${wallet.address}`);
  console.log(`💰 Wallet MATIC: ${ethers.formatEther(walletBalance)}`);
  console.log(`🏦 Vault USDC: ${ethers.formatUnits(vaultBalanceRaw, 6)}`);
  console.log(`📄 Contract: ${VAULT_ADDRESS}`);
}

/* ================= HYBRID ARBITRAGE ================= */

async function tryHybridArb(buyRouter, sellRouter, tokenAddr) {

  const usdcAddr = await vault.usdc();
  const vaultBalanceRaw = await getVaultBalance(usdcAddr);
  const vaultBalance = Number(ethers.formatUnits(vaultBalanceRaw, 6));

  const totalTarget = FIXED_TOTAL_USDC;

  let flashNeeded = totalTarget - vaultBalance;
  if (flashNeeded < 0) flashNeeded = 0;

  const flashAmount = ethers.parseUnits(
    flashNeeded.toFixed(6),
    6
  );

  if (flashAmount === 0n) {
    console.log("⚠ Vault has enough capital. No flash needed.");
    return;
  }

  const tradeAmount = ethers.parseUnits(totalTarget.toString(), 6);

  const buyPaths = buildPaths(usdcAddr, tokenAddr);
  const sellPaths = buildSellPaths(usdcAddr, tokenAddr);

  let expectedSell = null;
  let bestBuyPath = null;
  let bestSellPath = null;

  for (const buyPath of buyPaths) {
    const buyOut = await quote(buyRouter, tradeAmount, buyPath);
    if (!buyOut) continue;

    for (const sellPath of sellPaths) {
      const sellOut = await quote(sellRouter, buyOut, sellPath);
      if (!sellOut) continue;

      if (!expectedSell || sellOut > expectedSell) {
        expectedSell = sellOut;
        bestBuyPath = buyPath;
        bestSellPath = sellPath;
      }
    }
  }

  if (!expectedSell) return;

  const finalOut = Number(ethers.formatUnits(expectedSell, 6));

  const premium = flashNeeded * 0.0009;
  const estimatedProfit = finalOut - totalTarget - premium;

  if (estimatedProfit < MIN_EXPECTED_PROFIT) return;

  console.log(`🔥 HYBRID PROFIT FOUND: ${estimatedProfit.toFixed(6)} USDC`);
  console.log(`🏦 Vault Balance: ${vaultBalance.toFixed(6)} USDC`);
  console.log(`⚡ Flash Needed: ${flashNeeded.toFixed(6)} USDC`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const args = [
    buyRouter,
    sellRouter,
    flashAmount,
    bestBuyPath,
    bestSellPath,
    deadline
  ];

  const canExecute = await vaultWillExecute(args);
  if (!canExecute) return;

  const tx = await vault.executeFlashArbitrage(...args);

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

showSystemStatus().catch(console.error);

// ✅ Router approval removed — not needed, handled on-chain
// approveAllRouters().catch(console.error);

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
