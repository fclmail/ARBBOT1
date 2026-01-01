// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const RPC_URL = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const QUICK_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

// -------------------- TOKENS --------------------
const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6
const WETH   = "0x172370d5cd63279efa6d502dab29171933a610af"; // 18
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // 18
const DAI    = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"; // 18

// -------------------- VAULT --------------------
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

const VAULT_ABI = [
  "function depositProfit(uint amount) external"
];

const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);

// -------------------- SETTINGS --------------------
const TRADE_AMOUNT = ethers.parseUnits("1", 6); // 100 USDC
const MIN_PROFIT_USDC = 0.0001;
const SLIPPAGE_PCT = 1;

// -------------------- CONTRACTS --------------------
const quick = new ethers.Contract(QUICK_ROUTER, ROUTER_ABI, provider);
const sushi = new ethers.Contract(SUSHI_ROUTER, ROUTER_ABI, provider);

// -------------------- UTILS --------------------
async function getAmountsOut(router, amount, path) {
  try {
    return await router.getAmountsOut(amount, path);
  } catch {
    return null;
  }
}

function computeProfit(startUsdc, endUsdc) {
  const start = Number(ethers.formatUnits(startUsdc, 6));
  const end   = Number(ethers.formatUnits(endUsdc, 6));
  const gross = end - start;
  const adjusted = gross * (1 - SLIPPAGE_PCT / 100);
  const pct = (gross / start) * 100;
  return { gross, adjusted, pct };
}

async function vaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function walletMatic() {
  const bal = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}

// -------------------- PATHS --------------------
const PATHS = [
  [USDC, WETH, USDC],
  [USDC, WMATIC, USDC],
  [USDC, DAI, USDC],
  [USDC, WETH, DAI, USDC],
  [USDC, WMATIC, DAI, USDC],
  [USDC, DAI, WETH, USDC]
];

// -------------------- SCAN --------------------
async function scan() {
  console.log(`\n⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);
  console.log(`🏦 Vault USDC: ${(await vaultBalance()).toFixed(6)}`);
  console.log(`👛 Wallet MATIC: ${(await walletMatic()).toFixed(6)}`);

  const dexPairs = [
    { buy: quick, sell: sushi, name: "Quick ➜ Sushi" },
    { buy: sushi, sell: quick, name: "Sushi ➜ Quick" }
  ];

  let found = false;

  for (const dex of dexPairs) {
    for (const path of PATHS) {

      const buy = await getAmountsOut(dex.buy, TRADE_AMOUNT, path.slice(0, -1));
      if (!buy) continue;

      const midAmount = buy[buy.length - 1];
      if (midAmount < ethers.parseEther("0.001")) continue;

      const sell = await getAmountsOut(dex.sell, midAmount, path.slice().reverse());
      if (!sell) continue;

      const usdcBack = sell[sell.length - 1];
      const { gross, adjusted, pct } = computeProfit(TRADE_AMOUNT, usdcBack);

      console.log(`🔍 ${dex.name}`);
      console.log(`🛣 Path: ${path.join(" → ")}`);
      console.log(`💵 Price diff: ${pct.toFixed(3)} %`);
      console.log(`💵 Gross profit: ${gross.toFixed(6)} USDC`);
      console.log(`💵 Adjusted profit: ${adjusted.toFixed(6)} USDC`);

      if (adjusted >= MIN_PROFIT_USDC && pct > 0.8) {
        found = true;
        console.log(`✅ MIN PROFIT satisfied — executing`);

        const before = await vaultBalance();
        try {
          const tx = await vault.depositProfit(usdcBack);
          console.log(`📤 Tx: ${tx.hash}`);
          await tx.wait();
          const after = await vaultBalance();
          console.log(`💰 Vault before: ${before.toFixed(6)}`);
          console.log(`💰 Vault after : ${after.toFixed(6)}`);
        } catch (e) {
          console.log(`⚠️ Execution failed`);
        }
      } else {
        console.log(`❌ Below minimum profit`);
      }
    }
  }

  if (!found) console.log(`⚠️ No executable arbitrage this cycle`);
}

// -------------------- LOOP --------------------
async function start() {
  while (true) {
    try { await scan(); }
    catch (e) { console.error("Scan error:", e.message); }
    await new Promise(r => setTimeout(r, 3000));
  }
}

start();
