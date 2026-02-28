import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= CONFIG ================= */
dotenv.config({ override: false });

const RPC_POLYGON = (process.env.RPC_POLYGON || "").trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");

/* ================= SETTINGS ================= */
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 4000);
const DEADLINE_SECONDS = 60;
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT ================= */
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= AAVE V3 POLYGON ================= */
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

const aaveAbi = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns(uint128)",
  "function getReserveData(address asset) view returns(tuple(uint256,uint128,uint128,uint128,uint128,uint128,uint40,address,address,address,address,uint8))"
];

const aavePool = new ethers.Contract(AAVE_POOL, aaveAbi, provider);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */
const TOKENS = {
  USDT:  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK:  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE:  "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  DAI:   "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WETH:  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  UNI:   "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
  FRAX:  "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",
  BUSD:  "0x9c9e5fd8bbc25984b178fdce6117defa39d2db39",
  APE:   "0xb7b31a6bc18e48888545ce79e83e06003be70930",
  CRV:   "0x172370d5cd63279efa6d502dab29171933a610af",
  SAND:  "0xbbba073c31bf03b8acf7c28ef0738decf3695683",
  TUSD:  "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
  WOO:   "0x1b815d120b3ef02039ee11dc2d33de7aa4a8c603",
  XSGD:  "0xdc3326e71d45186f113a2f448984ca0e8d201995",
  MV:    "0xA3c322Ad15218fBFAEd26bA7f616249f7705D945",
  VCNT:  "0x8a16d4bf8a0a716017e8d2262c4ac32927797a2f"
};

const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/* ================= AAVE LIQUIDITY + FLASH RATE ================= */
async function getAaveFlashData(usdcAddress) {
  const reserve = await aavePool.getReserveData(usdcAddress);
  const liquidity = reserve[0];

  const premiumBps = await aavePool.FLASHLOAN_PREMIUM_TOTAL();
  const premiumPercent = Number(premiumBps) / 10000;

  console.log("\n🏦 AAVE V3 Liquidity (USDC):", Number(ethers.formatUnits(liquidity, 6)).toFixed(2));
  console.log("⚡ Flash Loan Premium:", premiumPercent, "%");

  return { liquidity, premiumPercent };
}

/* ================= PATH ENGINE ================= */
const FALLBACK_HOPS = [WMATIC, TOKENS.WETH, TOKENS.DAI, TOKENS.USDT];

function generatePaths(base, token) {
  const paths = [[base, token]];
  for (const hop of FALLBACK_HOPS) {
    if (hop !== token) paths.push([base, hop, token]);
  }
  return paths;
}

/* ================= CORE ARB ================= */
async function tryArb(buyRouter, sellRouter, token, flashAmount, flashPremium) {

  const usdc = await vault.usdc();
  const amountIn = flashAmount;

  const buyPaths = generatePaths(usdc, token);
  const sellPaths = generatePaths(token, usdc);

  for (const bPath of buyPaths) {
    for (const sPath of sellPaths) {

      const buyOut = await quote(buyRouter, amountIn, bPath);
      if (!buyOut) continue;

      const sellOut = await quote(sellRouter, buyOut, sPath);
      if (!sellOut) continue;

      const received = Number(ethers.formatUnits(sellOut, 6));
      const borrowed = Number(ethers.formatUnits(amountIn, 6));
      const fee = borrowed * flashPremium;
      const profit = received - borrowed - fee;

      console.log(`🔍 ${token} Profit Simulated: ${profit.toFixed(6)} USDC`);

      if (profit < MIN_EXPECTED_PROFIT) continue;

      const deadline = Math.floor(Date.now()/1000)+DEADLINE_SECONDS;

      if (DRY_RUN) {
        console.log("🧪 DRY RUN EXECUTION READY");
        return;
      }

      const tx = await vault.executeArbitrage(
        buyRouter,
        sellRouter,
        amountIn,
        bPath,
        sPath,
        deadline
      );

      console.log("⛓ TX SENT:", tx.hash);
      await tx.wait();
      console.log("✅ Arbitrage Executed");
      return;
    }
  }
}

/* ================= SCANNER ================= */
async function scan() {

  const usdc = await vault.usdc();
  const { liquidity, premiumPercent } = await getAaveFlashData(usdc);

  const bestFlashAmount = liquidity / 20n; // use 5% of pool dynamically

  console.log("💡 Using Flash Amount:", Number(ethers.formatUnits(bestFlashAmount,6)).toFixed(2), "USDC\n");

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await tryArb(buy, sell, token, bestFlashAmount, premiumPercent);
        await sleep(500);
      }
    }
  }
}

/* ================= MAIN ================= */
(async () => {
  console.log("🚀 Flash Arbitrage Bot Started (AAVE Dynamic Mode)\n");
  while (true) {
    try {
      await scan();
    } catch (err) {
      console.log("⚠️ Scan error:", err.message);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
