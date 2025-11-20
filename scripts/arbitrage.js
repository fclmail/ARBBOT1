// arbitrage.js — Full ARBJS with vault failsafes for your AaveFlashArb contract
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

// Vault / Arbitrage contract
const VAULT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const MIN_NET_PROFIT_USDC = 0.01;       // Minimum net profit to execute
const MAX_PRICE_DEVIATION = 0.10;       // Reject if price deviation > 10%
const SCAN_INTERVAL_MS = 10000;         // 10 sec scan interval
const TRADE_AMOUNT_USDC = 1;            // Example trade size
const SLIPPAGE_PCT = 0.2;

// Routers (Uniswap-style)
const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens (example)
const TOKENS = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ---------------- CONTRACT ABIS ----------------
const VAULT_ABI = [ /* use the ABI you provided */ ];
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)"
];

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const vaultContract = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
let usdcContract;

// ---------------- HELPERS ----------------
function fmt(n, dec=6){ return Number(n).toFixed(dec); }

async function getVaultBalanceUSDC() {
  if (!usdcContract) {
    const usdcAddr = await vaultContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, ERC20_ABI, provider);
  }
  const bal = await usdcContract.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

async function getAmountOut(routerAddr, tokenObj, amountInUSDC) {
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);
  const usdcAddr = await vaultContract.USDC();
  const amountIn = ethers.parseUnits(amountInUSDC.toString(), 6); // USDC decimals
  const path = [usdcAddr, tokenObj.address];
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return Number(ethers.formatUnits(amounts[1], tokenObj.decimals));
  } catch (err) { throw err; }
}

// ---------------- SCAN & EXECUTION ----------------
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  const vaultBefore = await getVaultBalanceUSDC();
  console.log(`🏦 Vault Before: ${fmt(vaultBefore)} USDC`);

  for (const [symbol, tokenObj] of Object.entries(TOKENS)) {
    for (const [buyName, buyRouter] of Object.entries(ROUTERS)) {
      for (const [sellName, sellRouter] of Object.entries(ROUTERS)) {
        if (buyRouter === sellRouter) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, tokenObj, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, tokenObj, TRADE_AMOUNT_USDC);
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          const rawProfit = sellPrice - buyPrice;

          console.log(`${symbol} | ${buyName} → ${sellName} | Buy $${fmt(buyPrice)} → Sell $${fmt(sellPrice)} | Est Profit ${fmt(rawProfit)} USDC`);

          if (rawProfit <= 0) continue;

          const deviation = Math.abs(buyPrice - sellPrice) / ((buyPrice + sellPrice)/2);
          if (deviation > MAX_PRICE_DEVIATION) {
            console.log(`⚠ Price deviation ${fmt(deviation*100)}% > ${MAX_PRICE_DEVIATION*100}% → blocked`);
            continue;
          }

          const gasEstUSDC = 0.005; // placeholder
          const netProfit = rawProfit - gasEstUSDC;
          if (netProfit < MIN_NET_PROFIT_USDC) {
            console.log(`❌ Net profit below minimum: ${fmt(netProfit)} USDC`);
            continue;
          }

          console.log("⏳ callStatic simulation...");
          await vaultContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenObj.address, ethers.parseUnits(TRADE_AMOUNT_USDC.toString(),6));
          console.log("✅ callStatic SUCCESS — ready to execute");

          const tx = await vaultContract.executeArbitrage(buyRouter, sellRouter, tokenObj.address, ethers.parseUnits(TRADE_AMOUNT_USDC.toString(),6));
          console.log(`🔗 txHash: ${tx.hash}`);
          const receipt = await tx.wait();
          if (receipt.status === 0) { console.log("❌ Tx reverted, vault safe"); continue; }

          const vaultAfter = await getVaultBalanceUSDC();
          const actualProfit = vaultAfter - vaultBefore;
          console.log(`🏦 Vault After: ${fmt(vaultAfter)} USDC | Profit: +${fmt(actualProfit)} USDC`);
          if (actualProfit > 0) console.log("🎉 SUCCESS — Vault increased\n");

        } catch (err) {
          console.warn(`⚠ Error with ${symbol} ${buyName}->${sellName}: ${err.message}`);
        }
      }
    }
  }
  console.log(`🔄 Scan complete. Next scan in ${SCAN_INTERVAL_MS/1000}s\n`);
}

// ---------------- MAIN LOOP ----------------
async function main() {
  console.log("🚀 LIVE MODE ENABLED — Vault failsafes ACTIVE");
  const owner = await vaultContract.owner();
  console.log(`🏛 Vault Owner: ${owner}\n`);
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
