import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/* ───────────────────────── SAFETY CHECKS ───────────────────────── */

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`❌ Missing environment variable: ${name}`);
  }
  return process.env[name];
}

const RPC_URL = requireEnv("RPC_URL");
const PRIVATE_KEY = requireEnv("PRIVATE_KEY");
const VAULT_ADDRESS = requireEnv("VAULT_ADDRESS");

/* ───────────────────────── CONFIG ───────────────────────── */

const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 505);
const MIN_PROFIT_PERCENT = Number(process.env.MIN_PROFIT_PERCENT || 0.05);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 3000);

/* ───────────────────────── COLORS ───────────────────────── */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/* ───────────────────────── PROVIDER ───────────────────────── */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ───────────────────────── ABIS ───────────────────────── */

const VAULT_ABI = [
  "function USDC() view returns(address)",
  "function balanceOfUSDC() view returns(uint256)",
  "function executeArb(address,address,address,uint256,uint256) external"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

const ERC20_ABI = [
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)"
];

/* ───────────────────────── UTILS ───────────────────────── */

const fmt = (v, d = 6) =>
  Number(ethers.formatUnits(v, d)).toFixed(6);

/* ───────────────────────── DEXES ───────────────────────── */

const DEXES = [
  { name: "QuickSwap", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "ApeSwap", router: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
];

/* ───────────────────────── TOKENS ───────────────────────── */

const TOKENS = [
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"  // WBTC
];

/* ───────────────────────── CORE LOOP ───────────────────────── */

async function scanOnce() {
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

  const usdc = await vault.USDC();
  if (!usdc || usdc === ethers.ZeroAddress) {
    throw new Error("❌ Vault returned invalid USDC address");
  }

  const usdcDecimals = 6;
  const amountIn = ethers.parseUnits(
    TRADE_AMOUNT_USDC.toString(),
    usdcDecimals
  );

  const vaultBefore = await vault.balanceOfUSDC();

  for (const tokenAddr of TOKENS) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const symbol = await token.symbol();
    const decimals = await token.decimals();

    for (const buyDex of DEXES) {
      for (const sellDex of DEXES) {
        if (buyDex.router === sellDex.router) continue;

        console.log(
          `\n${CYAN}🔍 ${symbol} | ${buyDex.name} → ${sellDex.name}${RESET}`
        );
        console.log(`🏦 Vault: ${fmt(vaultBefore)} USDC`);

        let buyOut, sellBack;

        try {
          const buyRouter = new ethers.Contract(
            buyDex.router,
            ROUTER_ABI,
            provider
          );
          const sellRouter = new ethers.Contract(
            sellDex.router,
            ROUTER_ABI,
            provider
          );

          buyOut = (await buyRouter.getAmountsOut(amountIn, [
            usdc,
            tokenAddr
          ]))[1];

          sellBack = (await sellRouter.getAmountsOut(buyOut, [
            tokenAddr,
            usdc
          ]))[1];
        } catch {
          console.log(`${YELLOW}⚠️ Quote failed${RESET}`);
          continue;
        }

        const profit = sellBack - amountIn;
        const profitPct =
          Number(ethers.formatUnits(profit, usdcDecimals)) /
          TRADE_AMOUNT_USDC *
          100;

        console.log(
          `📊 Profit: ${fmt(profit)} USDC (${profitPct.toFixed(4)}%)`
        );

        /* ONLY SKIP IF MIN PROFIT FAILS */
        if (profitPct < MIN_PROFIT_PERCENT) continue;

        /* SIMULATION */
        try {
          await vault.callStatic.executeArb(
            buyDex.router,
            sellDex.router,
            tokenAddr,
            amountIn,
            sellBack
          );
        } catch {
          console.log(`${RED}⚠️ Simulation reverted${RESET}`);
          continue;
        }

        console.log(`${GREEN}✅ Simulation passed${RESET}`);

        /* EXECUTION */
        const tx = await vault.executeArb(
          buyDex.router,
          sellDex.router,
          tokenAddr,
          amountIn,
          sellBack,
          { gasLimit: 1_500_000 }
        );

        console.log(`${GREEN}📤 TX:${RESET} ${tx.hash}`);

        const receipt = await tx.wait();
        const vaultAfter = await vault.balanceOfUSDC();

        console.log(
          `${GREEN}💰 REAL PROFIT:${RESET} ${fmt(
            vaultAfter - vaultBefore
          )} USDC`
        );

        return;
      }
    }
  }
}

/* ───────────────────────── CONTINUOUS SCAN ───────────────────────── */

async function main() {
  console.log(`${GREEN}🚀 Arbitrage bot started${RESET}`);

  while (true) {
    try {
      await scanOnce();
    } catch (err) {
      console.error(`${RED}❌ Error:${RESET}`, err.message);
    }

    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
