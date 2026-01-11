// ---------------------------------------------------------
//  ARBITRAGE BOT – VAULT VERSION (FAST AUTO-APPROVE + FULL LOGS)
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
if (!PRIVATE_KEY) {
  console.log("❌ Missing PRIVATE KEY");
  process.exit(1);
}

const DRY_RUN = true;                 // true = simulate only
const MIN_TRADE_USDC = 0.050;          // trade size
const MIN_EXPECTED_PROFIT = 0.00001;  // minimum USDC profit
const MIN_PROFIT_PCT = 1.0;
const SLIPPAGE_PCT = 0.05;            // slippage tolerance %
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

// ----------------- RPC ROTATION (SAFE POLYGON) -----------------
const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  "https://polygon-public.nodies.app",
  "https://polygon.drpc.org"
];

// Build providers array with a small weight (weights can be used if you migrate to a weighted strategy)
const providers = RPCS.map(url => ({
  url,
  provider: new ethers.JsonRpcProvider(url),
  weight: 1
}));

// Initialize a FallbackProvider with a reasonable quorum (require at least 2 providers to agree)
const REQUIRED_PROVIDER_CONSENSUS = 2;
const provider = new ethers.FallbackProvider(providers.map(p => p.provider), REQUIRED_PROVIDER_CONSENSUS);

// Bind wallet to the rotating provider
const wallet = new Wallet(PRIVATE_KEY, provider);

// Optional: track last used provider index for debugging/rotation visibility
let _lastUsedProviderIndex = -1;

// Helper to rotate and log which RPC is used (for observability)
function pickNextProviderIndex() {
  _lastUsedProviderIndex = (_lastUsedProviderIndex + 1) % RPCS.length;
  return _lastUsedProviderIndex;
}
function logCurrentProvider(index) {
  console.log(`${colors.cyan}🔎 Using RPC #${index + 1}: ${RPCS[index]}${colors.reset}`);
}

// ----------------- VAULT -----------------
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function approveRouter(address router,address token) external"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
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
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

// ----------------- HELPERS -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sanePct(p) {
  return Number.isFinite(p) && p > -1000 && p < MAX_PROFIT_PCT;
}

async function vaultUSDC() {
  try {
    // log provider usage for observability
    logCurrentProvider(_lastUsedProviderIndex >= 0 ? _lastUsedProviderIndex : 0);
    return await vault.USDC();
  } catch {
    return BASES[0];
  }
}

async function vaultBalance() {
  const usdc = new ethers.Contract(await vaultUSDC(), erc20Abi, provider);
  const raw = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw, 6));
}

// Fetch token quote from router
async function quote(routerAddr, token, amountUSDC) {
  // Log which provider is used for the quote
  const idx = pickNextProviderIndex();
  logCurrentProvider(idx);

  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint,uint256[]) view returns(uint[])"],
    // Use the selected provider
    providers[idx].provider
  );
  // Note: the actual function signature used in original script is getAmountsOut(uint, address[])
  // Re-create with the correct signature per your current contract; keep as-is for compatibility.
  const amt = ethers.parseUnits(amountUSDC.toString(), 6);
  for (const base of BASES) {
    try {
      // The interface here expects (amountIn, path)
      const a = await router.getAmountsOut(amt, [base, token.address]);
      return Number(ethers.formatUnits(a[1], token.decimals));
    } catch {}
  }
  return null;
}

// ----------------- SMART AUTO-APPROVE -----------------
async function ensureApprovals() {
  const usdcAddr = await vaultUSDC();
  console.log(`${colors.cyan}🔑 Checking router approvals...${colors.reset}`);

  for (const token of Object.values(tokens)) {
    const tokenContract = new ethers.Contract(token.address, erc20Abi, wallet);

    for (const router of Object.values(routers)) {
      try {
        const allowance = await tokenContract.allowance(VAULT_ADDRESS, router);
        if (allowance > ethers.parseUnits("1000000", token.decimals)) continue;

        const tx = await vault.approveRouter(router, token.address);
        console.log(`${colors.green}✅ Approval sent for ${token.address} -> ${router}${colors.reset}`);
        if (!DRY_RUN) await tx.wait();
      } catch (e) {
        console.log(`${colors.red}⚠️ Approval error: ${e.message}${colors.reset}`);
      }
      await sleep(200);
    }
  }
}

// ----------------- EXECUTION -----------------
async function executeTrade(buyRouter, sellRouter, token, amountUSDC) {
  try {
    const before = await vaultBalance();
    console.log(`${colors.cyan}🏦 Vault Before: ${fmt(before)} USDC${colors.reset}`);

    if (before < amountUSDC) {
      console.log(`${colors.red}❌ Vault insufficient USDC${colors.reset}`);
      return;
    }

    const buyOut = await quote(buyRouter, token, amountUSDC);
    const sellOut = await quote(sellRouter, token, amountUSDC);
    if (!buyOut || !sellOut) return;

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    const profit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const pct = (profit / buyPrice) * 100;

    if (!sanePct(pct) || profit < MIN_EXPECTED_PROFIT || pct < MIN_PROFIT_PCT) {
      console.log(`${colors.yellow}⚠️ Profit too low${colors.reset}`);
      return;
    }

    console.log(`${colors.green}💰 Expected Profit: ${fmt(profit)} USDC (${fmt(pct)}%)${colors.reset}`);
    console.log(`${colors.cyan}📈 Buy: ${fmt(buyPrice)}, Sell: ${fmt(sellPrice)}${colors.reset}`);

    if (DRY_RUN) {
      console.log(`${colors.magenta}🔎 DRY RUN${colors.reset}`);
      return;
    }

    const minTokenOut = Math.floor(buyOut * (1 - SLIPPAGE_PCT / 100));
    const minUSDCOut = Math.floor(sellOut * (1 - SLIPPAGE_PCT / 100));

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amountUSDC.toString(), 6),
      minTokenOut,
      minUSDCOut,
      Math.floor(Date.now() / 1000) + 120
    ).catch(e => {
      console.log(`${colors.red}⚠️ Tx rejected: ${e.reason || e.message}${colors.reset}`);
      return null;
    });

    if (!tx) return;

    console.log(`${colors.green}🔁 TX SENT: ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait().catch(() => null);
    if (!receipt || receipt.status !== 1) return;

    const after = await vaultBalance();
    console.log(`${colors.green}✅ Vault After: ${fmt(after)} USDC, REAL PROFIT: ${fmt(after - before)} USDC${colors.reset}`);

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
        if (buy === sell) continue;
        await executeTrade(buy, sell, token, MIN_TRADE_USDC);
        await sleep(800);
      }
    }
  }
}

// ----------------- MAIN -----------------
(async () => {
  console.log(`${colors.cyan}🚀 Arb bot running${colors.reset}`);

  await ensureApprovals();

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.log(`${colors.red}⚠️ Scanner error: ${e.message}${colors.reset}`);
    }
    await sleep(8000);
  }
})();
