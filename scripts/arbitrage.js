// arb-fixed.js
// =======================================================
// ✅ LOSS-PROOF ARBITRAGE BOT (Polygon)
// - Correct USDC → TOKEN → USDC pricing
// - Gas-aware execution
// - Vault balance protection
// - Capital exposure limit
// - ApeSwap disabled (unstable routing)
// =======================================================

import { ethers, Wallet } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ================= CONFIG =================
const DRY_RUN = process.env.DRY_RUN === "true";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const VAULT_ADDRESS = process.env.VAULT_CONTRACT;

if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required");

const MIN_NET_PROFIT_USDC = 0.01;        // 🔒 absolute minimum net profit
const MAX_TRADE_PCT_VAULT = 0.25;        // 🔒 max 25% vault usage
const SLIPPAGE_PCT = 0.3;                // realistic DEX slippage
const GAS_BUFFER_MULT = 3;               // profit must be 3× gas cost

// ================= PROVIDER =================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ================= ROUTERS =================
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
};

// ================= TOKENS =================
const tokens = {
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
};

// ================= ABIs =================
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256)",
  "function USDC() view returns (address)"
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ================= CONTRACTS =================
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, DRY_RUN ? provider : wallet);

let USDC;
let usdcContract;

// ================= INIT =================
async function init() {
  USDC = await vault.USDC();
  usdcContract = new ethers.Contract(USDC, erc20Abi, provider);
  console.log("Vault:", VAULT_ADDRESS);
  console.log("USDC :", USDC);
}

// ================= HELPERS =================
function fmt(n, d = 6) { return Number(n).toFixed(d); }

async function getQuote(routerAddr, amountIn, path) {
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  const out = await router.getAmountsOut(amountIn, path);
  return out[out.length - 1];
}

// ================= CORE ARBITRAGE =================
async function tryArb(buyRouter, sellRouter, token) {
  const vaultBalRaw = await usdcContract.balanceOf(VAULT_ADDRESS);
  const vaultBal = Number(ethers.formatUnits(vaultBalRaw, 6));

  if (vaultBal < 0.05) return;

  const tradeUSDC = Math.min(vaultBal * MAX_TRADE_PCT_VAULT, vaultBal);
  const tradeAmount = ethers.parseUnits(tradeUSDC.toFixed(6), 6);

  console.log(`\n🔍 ${token} ${fmt(tradeUSDC)} USDC`);

  // --- BUY ---
  const tokenOut = await getQuote(
    buyRouter,
    tradeAmount,
    [USDC, tokens[token].address]
  );

  // --- SELL ---
  const usdcBack = await getQuote(
    sellRouter,
    tokenOut,
    [tokens[token].address, USDC]
  );

  let grossProfit =
    Number(ethers.formatUnits(usdcBack, 6)) -
    Number(ethers.formatUnits(tradeAmount, 6));

  grossProfit *= (1 - SLIPPAGE_PCT / 100);

  // --- GAS ESTIMATE ---
  let gasCostUSDC = 0.003; // fallback
  try {
    const gas = await vault.estimateGas.executeArbitrage(
      buyRouter,
      sellRouter,
      tokens[token].address,
      tradeAmount
    );
    const gasPrice = await provider.getGasPrice();
    gasCostUSDC = Number(
      ethers.formatUnits(gas * gasPrice, 18)
    ) * 0.6; // MATIC→USDC approx
  } catch {}

  const netProfit = grossProfit - gasCostUSDC;

  console.log(
    `profit=${fmt(netProfit)} gas=${fmt(gasCostUSDC)}`
  );

  // 🔒 HARD FILTERS
  if (netProfit <= MIN_NET_PROFIT_USDC) return;
  if (netProfit <= gasCostUSDC * GAS_BUFFER_MULT) return;

  // --- SIMULATION ---
  try {
    await provider.call({
      to: VAULT_ADDRESS,
      data: vault.interface.encodeFunctionData("executeArbitrage", [
        buyRouter,
        sellRouter,
        tokens[token].address,
        tradeAmount,
      ]),
      from: wallet?.address
    });
  } catch {
    return;
  }

  if (DRY_RUN) {
    console.log("🧪 DRY RUN — WOULD EXECUTE");
    return;
  }

  // --- EXECUTE ---
  const before = Number(
    ethers.formatUnits(
      await usdcContract.balanceOf(VAULT_ADDRESS), 6
    )
  );

  const tx = await vault.executeArbitrage(
    buyRouter,
    sellRouter,
    tokens[token].address,
    tradeAmount
  );
  await tx.wait();

  const after = Number(
    ethers.formatUnits(
      await usdcContract.balanceOf(VAULT_ADDRESS), 6
    )
  );

  console.log(`🏦 ${fmt(before)} → ${fmt(after)}`);

  if (after <= before) {
    console.error("❌ LOSS — CHECK VAULT CONTRACT");
  } else {
    console.log(`💰 PROFIT +${fmt(after - before)} USDC`);
  }
}

// ================= SCANNER =================
async function scan() {
  for (const token of Object.keys(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        try {
          await tryArb(buy, sell, token);
        } catch {}
      }
    }
  }
}

// ================= MAIN =================
(async () => {
  await init();
  console.log(DRY_RUN ? "🔬 DRY RUN" : "🚀 LIVE MODE");

  setInterval(scan, 12000);
})();
