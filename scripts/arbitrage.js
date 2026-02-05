// 🟢1 FILE PURPOSE
// scripts/arbitrage.js

import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_RAW =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const PRIVATE_KEY_RAW =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

const RPC_POLYGON = RPC_RAW.trim();
const WALLET_PRIVATE_KEY = PRIVATE_KEY_RAW.trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON is missing or empty");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is missing or empty");

/* ================= CONSTANTS (UNCHANGED) ================= */

const MIN_TRADE_USDC = 1.7;
const MIN_EXPECTED_PROFIT = 0.0000001;
const SLIPPAGE_PCT = 0.05;
const SCAN_INTERVAL_MS = 20_000;
const DEADLINE_SECONDS = 60;

// Auto-withdraw settings
let AUTO_WITHDRAW_THRESHOLD = 0.05; // USDC threshold to trigger
let AUTO_WITHDRAW_PERCENT = 0.05; // % of vault to send (1-100)

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  {
    inputs: [
      { type: "address", name: "buyRouter" },
      { type: "address", name: "sellRouter" },
      { type: "uint256", name: "amountInUSDC" },
      { type: "address[]", name: "pathToToken" },
      { type: "address[]", name: "pathToUSDC" },
      { type: "uint256", name: "deadline" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
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
  MATICX: "0xa3fa99a148fa48d14ed51d610c367c61876997f1",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  UNI2: "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/* ================= PATH BUILDERS ================= */

function buildPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token],
    [usdc, TOKENS.USDT, token],
    [usdc, TOKENS.DAI, token],
    [usdc, TOKENS.WMATIC, TOKENS.WETH, token]
  ];
}

function buildSellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc],
    [token, TOKENS.USDT, usdc],
    [token, TOKENS.DAI, usdc],
    [token, TOKENS.WETH, TOKENS.WMATIC, usdc]
  ];
}

/* ================= BALANCE DISPLAY ================= */

async function showBalances(usdcAddr) {
  const maticBal = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );

  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

  console.log(
    `💰 Wallet MATIC: ${ethers.formatEther(maticBal)} | Vault USDC: ${Number(
      ethers.formatUnits(vaultBal, 6)
    ).toFixed(6)}`
  );
}

/* ================= AUTO-WITHDRAW FIXED ================= */

async function autoWithdraw(usdcAddr) {
  const vaultUsdc = new ethers.Contract(
    usdcAddr,
    [
      "function balanceOf(address) view returns(uint256)",
      "function transfer(address recipient, uint256 amount) returns(bool)",
      "function approve(address spender, uint256 amount) returns(bool)"
    ],
    wallet // ✅ connect to signer
  );

  const vaultBalance = await vaultUsdc.balanceOf(VAULT_ADDRESS);
  const vaultBalanceFloat = Number(ethers.formatUnits(vaultBalance, 6));

  if (vaultBalanceFloat >= AUTO_WITHDRAW_THRESHOLD) {
    const amountToSend = ethers.parseUnits(
      ((vaultBalanceFloat * AUTO_WITHDRAW_PERCENT) / 100).toFixed(6),
      6
    );

    console.log(
      `💸 Auto-withdraw triggered | Swapping ${Number(
        ethers.formatUnits(amountToSend, 6)
      ).toFixed(6)} USDC (${AUTO_WITHDRAW_PERCENT}% of vault)`
    );

    try {
      // Transfer directly to wallet
      const tx = await vaultUsdc.transfer(wallet.address, amountToSend);
      await tx.wait();
      console.log(
        `✅ Withdrawn ${Number(
          ethers.formatUnits(amountToSend, 6)
        ).toFixed(6)} USDC to wallet`
      );
    } catch (err) {
      console.log("⚠️ Auto-withdraw failed:", err.message);
    }
  }
}

/* ================= CORE LOGIC ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const buyPaths = buildPaths(usdc, tokenAddr);

  let bestBuyOut = null;
  let bestBuyPath = null;

  for (const path of buyPaths) {
    const out = await quote(buyRouter, amountIn, path);
    if (!out) continue;
    if (!bestBuyOut || out > bestBuyOut) {
      bestBuyOut = out;
      bestBuyPath = path;
    }
  }

  if (!bestBuyOut) return;

  const sellPaths = buildSellPaths(usdc, tokenAddr);

  let bestSellOut = null;
  let bestSellPath = null;

  for (const path of sellPaths) {
    const out = await quote(sellRouter, bestBuyOut, path);
    if (!out) continue;
    if (!bestSellOut || out > bestSellOut) {
      bestSellOut = out;
      bestSellPath = path;
    }
  }

  if (!bestSellOut) return;

  const receivedUSDC = Number(ethers.formatUnits(bestSellOut, 6));
  const profit = receivedUSDC - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log(`🔥 ARB FOUND | Profit ≈ ${profit.toFixed(6)} USDC`);

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    deadline
  );

  console.log(`⛓ TX SENT: ${tx.hash}`);

  tx.wait().then(async () => {
    console.log(`✅ CONFIRMED & DEPOSITED | ${tx.hash}`);
    await showBalances(usdc);
  });
}

/* ================= SCANNER ================= */

async function scan() {
  console.log(`🔍 Scan started @ ${new Date().toISOString()}`);

  const usdc = await vault.usdc();
  await showBalances(usdc);

  await autoWithdraw(usdc); // ✅ auto-withdraw called

  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        try {
          await tryArb(buy, sell, token);
          await sleep(100);
        } catch (e) {
          console.log(`⚠️ ${e.message}`);
        }
      }
    }
  }
}

/* ================= MAIN ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
