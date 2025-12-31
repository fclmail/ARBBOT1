// scripts/arb.js
// =======================================================
// POLYGON QUICKSWAP ↔ SUSHISWAP ARBITRAGE BOT
// NO EXTERNAL DEPENDENCIES (CI SAFE)
// =======================================================

import { ethers } from "ethers";

// ================= ANSI COLORS =================
const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;

// ================= CONFIG =================
const DRY_RUN = true;              // 🔁 true = simulate | false = send tx
const SLIPPAGE = 0.00;             // 5%
const TRADE_USDC = 10000.0;           // adjustable
const MIN_PROFIT_PCT = 0.0020;        // 0.5%
const CHECK_DELAY_MS = 3000;       // 3 seconds
const GAS_MULTIPLIER = 1.3;        // gas boost

// ================= POLYGON CONSTANTS =================
const RPC = "https://polygon-rpc.com";

const USDCe = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH  = "0x172370d5cd63279efa6d502dab29171933a610af";

const QUICKSWAP = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const VAULT = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// ================= PROVIDER / WALLET =================
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ================= ABI =================
const VAULT_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256)",
  "function USDC() view returns (address)"
];

// ================= CONTRACTS =================
const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

// ================= HELPERS =================
const now = () => new Date().toISOString();

function pct(final, initial) {
  return ((final - initial) / initial) * 100;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ================= ROUTERS =================
const routers = [
  { name: "QuickSwap", addr: QUICKSWAP },
  { name: "SushiSwap", addr: SUSHISWAP }
];

// =======================================================
// MAIN LOOP
// =======================================================
async function run() {

  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY missing");
  }

  console.log(cyan(`\n⏱ ${now()}  Polygon Arb Bot Started`));

  const maticBal = await provider.getBalance(wallet.address);
  console.log(`⛽ Wallet MATIC: ${ethers.formatEther(maticBal)}`);

  let vaultProfitAcc = 0;

  while (true) {

    for (let buy of routers) {
      for (let sell of routers) {

        if (buy.addr === sell.addr) continue;

        console.log(cyan(`\n🔍 ${buy.name} ➜ ${sell.name}`));

        try {
          const amountIn = ethers.parseUnits(
            TRADE_USDC.toString(),
            6
          );

          const buyRouter = new ethers.Contract(buy.addr, routerAbi, provider);
          const sellRouter = new ethers.Contract(sell.addr, routerAbi, provider);

          const buyPath = [USDCe, WETH];
          const sellPath = [WETH, USDCe];

          // ================= BUY PRICE =================
          const buyQuote = await buyRouter.getAmountsOut(amountIn, buyPath);
          const wethReceived = buyQuote[1];

          // ================= SELL PRICE =================
          const sellQuote = await sellRouter.getAmountsOut(wethReceived, sellPath);
          const usdcReceived = sellQuote[1];

          const usdcOut = Number(ethers.formatUnits(usdcReceived, 6));
          const profitUSDC = usdcOut - TRADE_USDC;
          const profitPct = pct(usdcOut, TRADE_USDC);

          console.log(`📈 Buy ${buy.name}: ${ethers.formatUnits(wethReceived, 18)} WETH`);
          console.log(`📉 Sell ${sell.name}: ${usdcOut.toFixed(6)} USDC`);
          console.log(`💵 Profit: ${profitUSDC.toFixed(6)} USDC (${profitPct.toFixed(2)}%)`);

          if (profitPct < MIN_PROFIT_PCT) {
            console.log(yellow("⚠️ Below minimum profit – skipping"));
            continue;
          }

          console.log(green("💰 PROFITABLE OPPORTUNITY"));

          if (DRY_RUN) {
            console.log(cyan("🧪 DRY RUN – no transaction sent"));
            continue;
          }

          // ================= GAS =================
          const fee = await provider.getFeeData();
          const gasPrice =
            fee.gasPrice * BigInt(Math.floor(GAS_MULTIPLIER * 100)) / 100n;

          // ================= MIN RETURN =================
          const minReturnUSDC =
            amountIn +
            BigInt(Math.floor(Number(amountIn) * (MIN_PROFIT_PCT / 100)));

          // ================= EXECUTE =================
          const tx = await vault.executeArbitrage(
            buy.addr,
            sell.addr,
            WETH,
            amountIn,
            minReturnUSDC,
            { gasPrice }
          );

          console.log(green(`🚀 TX SENT: ${tx.hash}`));

          const receipt = await tx.wait();
          console.log(green(`✅ CONFIRMED: ${receipt.transactionHash}`));

          vaultProfitAcc += profitUSDC;
          console.log(
            green(`🏦 Vault Accumulated Profit: ${vaultProfitAcc.toFixed(6)} USDC`)
          );

        } catch (err) {
          console.log(red("❌ REVERT / PROTECTED"));
          console.log("Vault balance unchanged – moving on");
        }

        await sleep(CHECK_DELAY_MS);
      }
    }
  }
}

run();
