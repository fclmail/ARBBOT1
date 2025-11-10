// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (v6 compatible)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // ✅ Hardcoded contract

console.log("PRIVATE_KEY:", PRIVATE_KEY ? "[OK]" : "[MISSING]");
console.log("CONTRACT_ADDRESS:", CONTRACT_ADDRESS ? "[OK]" : "[MISSING]");

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ABI ───────────────
const arbContract = new ethers.Contract(
  ethers.getAddress(CONTRACT_ADDRESS),
  [
    "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
    "function USDC() view returns(address)"
  ],
  wallet
);

// ─────────────── ROUTERS ───────────────
const routerAddresses = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routers = {};
for (const [name, addr] of Object.entries(routerAddresses)) {
  try {
    routers[name] = ethers.getAddress(addr);
  } catch {
    console.warn(`⚠️ Skipping invalid router: ${addr}`);
  }
}

// ─────────────── TOKENS ───────────────
const tokenList = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  MATICX: { address: "0xa3fa99a148fa48d14ed51d610c367c61876997f1", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  UNI: { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals: 18 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

const tokens = {};
for (const [symbol, tok] of Object.entries(tokenList)) {
  try {
    tokens[symbol] = { address: ethers.getAddress(tok.address), decimals: tok.decimals };
  } catch {
    console.warn(`⚠️ Invalid token address: ${tok.address}`);
  }
}

// ─────────────── SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 10;  // amount per trade
const MIN_PROFIT_PCT = 3;      // threshold %
const SLIPPAGE_PCT = 0;        // assume perfect execution

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const path = [tokens.USDT.address, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    const path2 = [tokens.USDT.address, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path2
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const usdcAddress = await arbContract.USDC();
    const usdcContract = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);

    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);

    // CallStatic first (simulate)
    await arbContract.callStatic.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
    );

    // Send actual transaction
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6),
      { gasLimit: 2_000_000 }
    );

    console.log(`⏳ Trade sent: ${tx.hash}`);
    await tx.wait();

    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const profit = Number(ethers.formatUnits(afterBal - beforeBal, 6));
    console.log(`✅ Trade succeeded! 💰 Profit this trade: ${fmt(profit)} USDC | New balance: ${fmt(Number(ethers.formatUnits(afterBal, 6)))} USDC`);
  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ token: symbol, buyName, sellName, profitUSDC, profitPct });
            console.log(`🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`⚠️ Error ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000)); // 5s delay between scans
  }
}

main().catch(console.error);
