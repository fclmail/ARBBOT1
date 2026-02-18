import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const WALLET_PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

/* ================= CONFIG ================= */

const FLASH_AMOUNT_USDC = .2;         // Adjust as needed
const SCAN_INTERVAL_MS = 30000;         // 30s
const DEADLINE_SECONDS = 60;

const FLASH_FEE_BPS = 9;                // 0.09%
const GAS_LIMIT_ESTIMATE = 800000;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT ================= */

const VAULT_ADDRESS =
  "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E";

const vaultAbi = [
  {
    name: "executeFlashArbitrage",
    type: "function",
    inputs: [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "address[]" },
      { type: "uint256" }
    ],
    stateMutability: "nonpayable"
  },
  {
    name: "usdc",
    type: "function",
    outputs: [{ type: "address" }],
    stateMutability: "view"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  LINK:   "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  WBTC:   "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const HOPS = {
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  USDT:   "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function flashFee(amount) {
  return (amount * BigInt(FLASH_FEE_BPS)) / 10000n;
}

/* Convert gas cost (MATIC) → USDC */
async function estimateGasCostInUSDC() {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  const totalGasWei = gasPrice * BigInt(GAS_LIMIT_ESTIMATE);

  const usdc = await vault.usdc();

  const router = new ethers.Contract(
    routers.QuickSwap,
    routerAbi,
    provider
  );

  try {
    const amounts = await router.getAmountsOut(
      totalGasWei,
      [HOPS.WMATIC, usdc]
    );
    return amounts[1]; // USDC (6 decimals)
  } catch {
    return 0n;
  }
}

/* ================= PATH BUILDERS ================= */

function buildBuyPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, HOPS.WMATIC, token],
    [usdc, HOPS.WETH, token],
    [usdc, HOPS.USDT, token]
  ];
}

function buildSellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, HOPS.WMATIC, usdc],
    [token, HOPS.WETH, usdc],
    [token, HOPS.USDT, usdc]
  ];
}

/* ================= SIMULATION ================= */

async function simulate(buyRouterAddr, sellRouterAddr, tokenAddr) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(
    FLASH_AMOUNT_USDC.toString(),
    6
  );

  const buyRouter = new ethers.Contract(buyRouterAddr, routerAbi, provider);
  const sellRouter = new ethers.Contract(sellRouterAddr, routerAbi, provider);

  const buyPaths = buildBuyPaths(usdc, tokenAddr);
  const sellPaths = buildSellPaths(usdc, tokenAddr);

  for (const buyPath of buyPaths) {
    try {
      const buyOut = await buyRouter.getAmountsOut(amountIn, buyPath);
      const tokensReceived = buyOut[buyOut.length - 1];

      for (const sellPath of sellPaths) {
        try {
          const sellOut = await sellRouter.getAmountsOut(tokensReceived, sellPath);
          const usdcBack = sellOut[sellOut.length - 1];

          return {
            profit: usdcBack - amountIn,
            buyPath,
            sellPath
          };
        } catch {}
      }
    } catch {}
  }

  return null;
}

/* ================= EXECUTION ================= */

async function executeArb(buyRouter, sellRouter, buyPath, sellPath) {
  const amount = ethers.parseUnits(
    FLASH_AMOUNT_USDC.toString(),
    6
  );

  const tx = await vault.executeFlashArbitrage(
    buyRouter,
    sellRouter,
    amount,
    buyPath,
    sellPath,
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
  );

  console.log("⚡ Flash loan sent:", tx.hash);
  await tx.wait();
  console.log("✅ FLASH ARB CONFIRMED:", tx.hash);
}

/* ================= SCAN ================= */

async function scan() {
  console.log("\n🔍 Scan @", new Date().toISOString());

  const gasCost = await estimateGasCostInUSDC();
  const amountIn = ethers.parseUnits(
    FLASH_AMOUNT_USDC.toString(),
    6
  );
  const fee = flashFee(amountIn);

  console.log("Gas (USDC):", ethers.formatUnits(gasCost, 6));
  console.log("Flash Fee:", ethers.formatUnits(fee, 6));

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {

        if (buy === sell) continue;

        const result = await simulate(buy, sell, token);
        if (!result) continue;

        const net = result.profit - fee - gasCost;

        console.log(
          "Route checked | Raw:",
          ethers.formatUnits(result.profit, 6),
          "| Net:",
          ethers.formatUnits(net, 6)
        );

        if (net > 0n) {
          console.log("🔥 PROFITABLE ROUTE FOUND");
          await executeArb(
            buy,
            sell,
            result.buyPath,
            result.sellPath
          );
          return;
        }
      }
    }
  }

  console.log("No profitable routes this round.");
}

/* ================= MAIN ================= */

(async function mainLoop() {
  console.log("🚀 Flash Arbitrage Bot Started (FINAL FIXED VERSION)");

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error("Scan error:", e.message);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
})();
