// scripts/arb.js
// =======================================================
// POLYGON QUICKSWAP ↔ SUSHISWAP ARBITRAGE BOT
// - Uses ArbVault minimum-profit enforcement
// - Vault funds ONLY
// - MEV aware
// - Dry-run / Live toggle
// =======================================================

import { ethers } from "ethers";
import chalk from "chalk";

// ---------------- CONFIG ----------------
const DRY_RUN = true;               // 🔁 true = simulate only | false = send tx
const SLIPPAGE = 0.05;              // 5% example (0.05)
const TRADE_USDC = 10.0;            // adjustable trade amount
const MIN_PROFIT_PCT = 0.5;         // 0.5% minimum per trade
const CHECK_DELAY_MS = 3000;        // wait 3 seconds
const GAS_MULTIPLIER = 1.3;         // industry-standard boost

// ---------------- PROVIDER ----------------
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");

// ---------------- WALLET ----------------
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ---------------- CONTRACT ----------------
const vault = new ethers.Contract(
  VAULT,
  ABI,
  wallet
);

// ---------------- ROUTERS ----------------
const routers = [
  { name: "QuickSwap", addr: QUICKSWAP_ROUTER },
  { name: "SushiSwap", addr: SUSHISWAP_ROUTER }
];

// ---------------- ERC20 ----------------
const erc20 = [
  "function balanceOf(address) view returns (uint)",
  "function decimals() view returns (uint8)"
];

const usdc = new ethers.Contract(USDCe, erc20, provider);

// ---------------- HELPERS ----------------
const now = () => new Date().toISOString();

function pct(a, b) {
  return ((a - b) / b) * 100;
}

// =======================================================
// MAIN LOOP
// =======================================================
async function run() {

  console.log(chalk.cyan(`\n⏱ ${now()}  Polygon Arbitrage Bot Started`));

  const maticBal = await provider.getBalance(wallet.address);
  console.log(`⛽ Wallet MATIC: ${ethers.formatEther(maticBal)}`);

  let vaultProfitAcc = 0;

  while (true) {

    for (let buy of routers) {
      for (let sell of routers) {
        if (buy.addr === sell.addr) continue;

        console.log(`\n🔍 Checking ${buy.name} ➜ ${sell.name}`);

        try {
          const amountIn = ethers.parseUnits(
            TRADE_USDC.toString(),
            6
          );

          // ----------- PRICE FETCH (LIVE) -----------
          const buyRouter = new ethers.Contract(
            buy.addr,
            ["function getAmountsOut(uint,address[]) view returns(uint[])"],
            provider
          );

          const sellRouter = new ethers.Contract(
            sell.addr,
            ["function getAmountsOut(uint,address[]) view returns(uint[])"],
            provider
          );

          const buyPath = [USDCe, WETH];
          const sellPath = [WETH, USDCe];

          const buyOut = await buyRouter.getAmountsOut(amountIn, buyPath);
          const wethReceived = buyOut[1];

          const sellOut = await sellRouter.getAmountsOut(wethReceived, sellPath);
          const usdcReceived = sellOut[1];

          const profit = usdcReceived - amountIn;
          const profitPct = pct(
            Number(ethers.formatUnits(usdcReceived, 6)),
            TRADE_USDC
          );

          console.log(
            `📈 Buy ${buy.name}: ${ethers.formatUnits(wethReceived, 18)} WETH`
          );
          console.log(
            `📉 Sell ${sell.name}: ${ethers.formatUnits(usdcReceived, 6)} USDC`
          );
          console.log(
            `💵 Profit: ${ethers.formatUnits(profit, 6)} USDC (${profitPct.toFixed(2)}%)`
          );

          if (profitPct < MIN_PROFIT_PCT) {
            console.log(chalk.yellow("⚠️ Below min profit – skipping"));
            continue;
          }

          console.log(chalk.green("💰 PROFITABLE OPPORTUNITY FOUND"));

          if (DRY_RUN) {
            console.log(chalk.blue("🧪 DRY RUN – no transaction sent"));
            continue;
          }

          // ----------- GAS BOOST -----------
          const fee = await provider.getFeeData();
          const gasPrice = fee.gasPrice * BigInt(Math.floor(GAS_MULTIPLIER * 100)) / 100n;

          // ----------- MIN RETURN ENFORCEMENT -----------
          const minReturn = amountIn + BigInt(
            (Number(amountIn) * MIN_PROFIT_PCT) / 100
          );

          const tx = await vault.executeArbitrage(
            buy.addr,
            sell.addr,
            WETH,
            amountIn,
            minReturn,
            { gasPrice }
          );

          console.log(chalk.green(`🚀 TX SENT: ${tx.hash}`));

          const receipt = await tx.wait();

          console.log(chalk.green(`✅ CONFIRMED: ${receipt.transactionHash}`));

          vaultProfitAcc += Number(ethers.formatUnits(profit, 6));
          console.log(chalk.green(`🏦 Vault Accumulated Profit: ${vaultProfitAcc.toFixed(6)} USDC`));

        } catch (err) {
          console.log(chalk.red("❌ REVERT / PROTECTED"));
          console.log("Vault balance unchanged – skipping next pair");
        }

        await new Promise(r => setTimeout(r, CHECK_DELAY_MS));
      }
    }
  }
}

run();
