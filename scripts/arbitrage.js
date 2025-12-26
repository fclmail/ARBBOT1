import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/* ───────────────────────── CONFIG ───────────────────────── */

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;

const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 505);
const MIN_PROFIT_PERCENT = Number(process.env.MIN_PROFIT_PERCENT || 0.05);

/* ───────────────────────── COLORS ───────────────────────── */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/* ───────────────────────── PROVIDER ───────────────────────── */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ───────────────────────── ABIS ───────────────────────── */

const VAULT_ABI = [
  "function USDC() view returns(address)",
  "function balanceOfUSDC() view returns(uint256)",
  "function executeArb(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minOut) external"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

const ERC20_ABI = [
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)"
];

/* ───────────────────────── HELPERS ───────────────────────── */

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
  { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" }, // WETH
  { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" }, // WBTC
  { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" }  // USDC (ignored later)
];

/* ───────────────────────── CORE ───────────────────────── */

async function runArb() {
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const usdc = await vault.USDC();
  const usdcDecimals = 6;

  const amountIn = ethers.parseUnits(
    TRADE_AMOUNT_USDC.toString(),
    usdcDecimals
  );

  const vaultBefore = await vault.balanceOfUSDC();

  for (const tokenCfg of TOKENS) {
    if (tokenCfg.address.toLowerCase() === usdc.toLowerCase()) continue;

    const token = new ethers.Contract(tokenCfg.address, ERC20_ABI, provider);
    const symbol = await token.symbol();
    const decimals = await token.decimals();

    for (const buyDex of DEXES) {
      for (const sellDex of DEXES) {
        if (buyDex.router === sellDex.router) continue;

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

        console.log(`\n🔍 ${symbol} | Buy: ${buyDex.name} → Sell: ${sellDex.name}`);
        console.log(`🏦 Vault Before: ${fmt(vaultBefore)} USDC`);

        let buyOut, sellBack;

        try {
          const buyAmounts = await buyRouter.getAmountsOut(amountIn, [
            usdc,
            tokenCfg.address
          ]);
          buyOut = buyAmounts[1];

          const sellAmounts = await sellRouter.getAmountsOut(buyOut, [
            tokenCfg.address,
            usdc
          ]);
          sellBack = sellAmounts[1];
        } catch {
          console.log(`${YELLOW}⚠️ Price fetch failed${RESET}`);
          continue;
        }

        const buyPrice =
          TRADE_AMOUNT_USDC /
          Number(ethers.formatUnits(buyOut, decimals));

        const sellPrice =
          Number(ethers.formatUnits(sellBack, usdcDecimals)) /
          Number(ethers.formatUnits(buyOut, decimals));

        const profit = sellBack - amountIn;
        const profitPct =
          Number(ethers.formatUnits(profit, usdcDecimals)) /
          TRADE_AMOUNT_USDC *
          100;

        console.log(`🔹 BuyOut: ${fmt(buyOut, decimals)} ${symbol}`);
        console.log(`🔹 SellBack: ${fmt(sellBack)} USDC`);
        console.log(`💱 Buy Price: ${buyPrice.toFixed(6)} USDC`);
        console.log(`💱 Sell Price: ${sellPrice.toFixed(6)} USDC`);
        console.log(
          `📊 Expected Profit: ${fmt(profit)} USDC (${profitPct.toFixed(4)}%)`
        );

        /* ───── ONLY SKIP IF MIN PROFIT FAILS ───── */

        if (profitPct < MIN_PROFIT_PERCENT) {
          console.log(
            `${YELLOW}⛔ Skipped — below min profit${RESET}`
          );
          continue;
        }

        /* ───── ONCHAIN SIMULATION ───── */

        try {
          await vault.callStatic.executeArb(
            buyDex.router,
            sellDex.router,
            tokenCfg.address,
            amountIn,
            sellBack
          );
        } catch {
          console.log(
            `${RED}⚠️ Simulation reverted${RESET}`
          );
          continue;
        }

        console.log(`${GREEN}🔬 Simulation passed${RESET}`);

        /* ───── EXECUTION ───── */

        const tx = await vault.executeArb(
          buyDex.router,
          sellDex.router,
          tokenCfg.address,
          amountIn,
          sellBack,
          { gasLimit: 1_500_000 }
        );

        console.log(`${GREEN}📤 TX SENT:${RESET} ${tx.hash}`);

        const receipt = await tx.wait();
        const vaultAfter = await vault.balanceOfUSDC();
        const realProfit = vaultAfter - vaultBefore;

        console.log(
          `${GREEN}✅ TX MINED${RESET} | Block ${receipt.blockNumber}`
        );
        console.log(
          `${GREEN}💰 REAL PROFIT:${RESET} ${fmt(realProfit)} USDC`
        );

        return; // stop after first successful arb
      }
    }
  }
}

/* ───────────────────────── RUN ───────────────────────── */

runArb().catch(console.error);
