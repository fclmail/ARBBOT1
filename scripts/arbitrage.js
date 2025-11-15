// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Safe CallStatic + Logging)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG 🟢1 ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // hardcoded
const MIN_PROFIT_USDC = 1; // minimum profit after gas
const TRADE_AMOUNT_USDC = 0.02; // small trade for testing

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or ARB_CONTRACT");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── FULL CONTRACT ABI 🟢2 ───────────────
const arbAbi = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amount) external",
  "function USDC() external view returns(address)",
  "function owner() external view returns(address)"
];

// ─────────────── CONTRACT CONNECTION 🟢3 ───────────────
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS 🟢4 ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09b6A2641CF6F90F643E76D3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS 🟢5 ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ─────────────── HELPERS 🟢6 ───────────────
const fmt = (n, dec = 4) => Number(n).toFixed(dec);
const norm = (addr) => { try { return ethers.getAddress(addr); } catch { return null; } };

// ─────────────── GET AMOUNT OUT 🟢7 ───────────────
async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path2 = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path2);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── EXECUTE TRADE 🟢8 ───────────────
async function executeTrade(buyRouter, sellRouter, token, amountUSDC) {
  const buy = norm(buyRouter);
  const sell = norm(sellRouter);
  const tok = norm(token.address);
  if (!buy || !sell || !tok) return { executed: false, reason: "Invalid address" };

  const contractBalance = Number(ethers.formatUnits(await (await arbContract.USDC()), 6));
  const walletBalance = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));

  console.log(`\n🔹 Checking trade: ${token.address} | Buy: ${buyRouter} | Sell: ${sellRouter}`);
  console.log(`Contract USDC balance: ${contractBalance.toFixed(6)}, Wallet MATIC: ${walletBalance.toFixed(6)}`);

  // callStatic simulation
  try {
    await arbContract.callStatic.executeArbitrage(buy, sell, tok, ethers.parseUnits(amountUSDC.toString(), 6));
    console.log("✅ callStatic simulation passed");
  } catch (err) {
    console.log("✖ callStatic would fail:", err.reason || err.message);
    return { executed: false, reason: "callStatic failed" };
  }

  // Live transaction
  try {
    const tx = await arbContract.executeArbitrage(buy, sell, tok, ethers.parseUnits(amountUSDC.toString(), 6), { gasLimit: 2500000 });
    const receipt = await tx.wait();
    console.log(`🚀 Arbitrage executed: ${receipt.transactionHash}`);
    return { executed: true, hash: receipt.transactionHash };
  } catch (err) {
    console.log("✖ Execution failed:", err.reason || err.message);
    return { executed: false, reason: "Execution failed" };
  }
}

// ─────────────── SCAN LOOP 🟢9 ───────────────
async function scan() {
  console.log("\n🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          const profitUSDC = (sellPrice - buyPrice) * (1 - 0 / 100); // SLIPPAGE_PCT = 0

          console.log(`🚨 ${symbol} | Buy:${buyName} @$${fmt(buyPrice)} -> Sell:${sellName} @$${fmt(sellPrice)} | Profit: ${fmt(profitUSDC)} USDC`);

          if (profitUSDC >= MIN_PROFIT_USDC) {
            const result = await executeTrade(buyRouter, sellRouter, token, TRADE_AMOUNT_USDC);
            if (result.executed) console.log(`✅ Trade successful: ${result.hash}`);
          }

        } catch (err) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${err.message}`);
        }
      }
    }
  }
}

// ─────────────── MAIN LOOP 🟢10 ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);

