import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19b64f74553ee0ee26ba01bf34321735e4701c43"; // Hardcoded

console.log("PRIVATE_KEY:", PRIVATE_KEY ? "[OK]" : "[MISSING]");
console.log("CONTRACT_ADDRESS:", CONTRACT_ADDRESS ? "[OK]" : "[MISSING]");

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  [
    "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
    "function USDC() view returns(address)"
  ],
  wallet
);

// ─────────────── SAFE ADDRESS HELPER ───────────────
function safeAddress(addr) {
  try {
    return ethers.getAddress(addr);
  } catch {
    console.warn(`⚠️ Skipping invalid address: ${addr}`);
    return null;
  }
}

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: safeAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
  SushiSwap: safeAddress("0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"),
  Dfyn: safeAddress("0xA8b607Aa09B6A2641CF6F90f643E76D3F6E6Ff73"),
  ApeSwap: safeAddress("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607")
};

// ─────────────── TOKENS ───────────────
const tokens = {
  AAVE: { address: safeAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"), decimals: 18 },
  CRV: { address: safeAddress("0x172370d5cd63279efa6d502dab29171933a610af"), decimals: 18 },
  DAI: { address: safeAddress("0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"), decimals: 18 },
  KLIMA: { address: safeAddress("0x4e78011ce80ee02d2c3e649fb657e45898257815"), decimals: 9 },
  LINK: { address: safeAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"), decimals: 18 },
  MATICX: { address: safeAddress("0xa3fa99a148fa48d14ed51d610c367c61876997f1"), decimals: 18 },
  QUICK: { address: safeAddress("0x831753dd7087cac61ab5644b308642cc1c33dc13"), decimals: 18 },
  UNI: { address: safeAddress("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"), decimals: 18 },
  UNI2: { address: safeAddress("0xb33eaad8d922b1083446dc23f610c2567fb5180f"), decimals: 18 },
  USDC: { address: safeAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174"), decimals: 6 },
  USDT: { address: safeAddress("0xc2132d05d31c914a87c6611c10748aeb04b58e8f"), decimals: 6 },
  WBTC: { address: safeAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"), decimals: 8 },
  WETH: { address: safeAddress("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"), decimals: 18 },
  XSGD: { address: safeAddress("0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0"), decimals: 6 }
};

// ─────────────── SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 10;
const MIN_PROFIT_PCT = 5;
const SLIPPAGE_PCT = 0;

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountIn) {
  if (!routerAddr || !token.address) return 0; // skip invalid
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const path = [tokens.USDC.address, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path2 = [tokens.USDC.address, tokens.WETH.address, token.address];
    try {
      const amounts = await router.getAmountsOut(
        ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
        path2
      );
      return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
    } catch {
      return 0;
    }
  }
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  if (!buyRouter || !sellRouter || !tokenAddr) {
    console.warn("⚠️ Skipping trade due to invalid address");
    return;
  }

  try {
    await arbContract.callStatic.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), tokens.USDC.decimals)
    );

    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), tokens.USDC.decimals),
      { gasLimit: 1_500_000 }
    );

    console.log(`⏳ Trade sent: ${tx.hash}`);
    await tx.wait();

    const usdcAddress = await arbContract.USDC();
    const usdcContract = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);
    const balance = await usdcContract.balanceOf(arbContract.address);
    console.log(`✅ Trade succeeded! Contract USDC balance: ${ethers.formatUnits(balance, 6)} USDC`);
  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    if (!token.address) continue; // skip invalid token

    for (const [buyName, buyRouter] of Object.entries(routers)) {
      if (!buyRouter) continue; // skip invalid router
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (!sellRouter || buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          if (buyOut === 0 || sellOut === 0) continue; // skip invalid paths

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;
          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ token: symbol, buyName, sellName, buyPrice, sellPrice, profitUSDC, profitPct });
            console.log(`🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: $${fmt(profitUSDC)} (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn(`⚠️ Error ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.`);
  return opportunities;
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 3000));
  }
}

main().catch(console.error);


