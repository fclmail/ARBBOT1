import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const CONTRACT_ADDRESS = "0x19b64f74553ee0ee26ba01bf34321735e4701c43";
const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  [
    "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
  ],
  wallet
);

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS ───────────────
const tokens = {
   AAVE:{address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",decimals:18},
      CRV:{address:"0x172370d5cd63279efa6d502dab29171933a610af",decimals:18},
      DAI:{address:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",decimals:18},
      KLIMA:{address:"0x4e78011ce80ee02d2c3e649fb657e45898257815",decimals:9},
      LINK:{address:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",decimals:18},
      MATICX:{address:"0xa3fa99a148fa48d14ed51d610c367c61876997f1",decimals:18},
      QUICK:{address:"0x831753dd7087cac61ab5644b308642cc1c33dc13",decimals:18},
      UNI:{address:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",decimals:18},
      UNI2:{address:"0xb33eaad8d922b1083446dc23f610c2567fb5180f",decimals:18}, // separate key
      USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6},
      USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
      WBTC:{address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",decimals:8},
      WETH:{address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",decimals:18},
      XSGD:{address:"0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0",decimals:6}
  // Add more tokens as in HTML if needed
};

// ─────────────── TRADE SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 10; // trade amount in USDC
const MIN_PROFIT_PCT = 5; // minimum profit %
const SLIPPAGE_PCT = 0; // adjust like HTML

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 6) {
  return Number(n).toFixed(dec);
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const path = [tokens.USDC.address, token.address];
  let out;

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    out = Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    // fallback via WETH
    const path2 = [tokens.USDC.address, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path2
    );
    out = Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }

  return out;
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("Starting arbitrage scan...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          // Profit calculation matches HTML
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          // Apply slippage
          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

         if (profitPct >= MIN_PROFIT_PCT) {
  opportunities.push({ token: symbol, buyName, sellName, buyPrice, sellPrice, profitUSDC, profitPct });
  console.log(
    `🚨 ${symbol} | Buy:${buyName} Sell:${sellName} Profit: $${fmt(profitUSDC)} (${fmt(profitPct, 2)}%)`
  );

  try {
    // ✅ Execute trade automatically with checksummed addresses
    await executeTrade(
      ethers.getAddress(buyRouter),
      ethers.getAddress(sellRouter),
      ethers.getAddress(token.address),
      TRADE_AMOUNT_USDC
    );
  } catch (err) {
    console.warn(`⚠️ Failed to execute trade: ${err.message}`);
  }
}

        } catch (e) {
          console.warn(`⚠️ Error ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`Scan complete. Found ${opportunities.length} opportunities.`);
  return opportunities;
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), tokens.USDC.decimals),
      { gasLimit: 1_500_000 }
    );
    console.log(`✅ Trade executed: ${tx.hash}`);
    await tx.wait();
  } catch (e) {
    console.error(`⚠️ Trade failed: ${e.message}`);
  }
}

// ─────────────── START ───────────────
async function main() {
  while (true) {
    await scan();
    await new Promise((r) => setTimeout(r, 3000)); // scan every 3 s
  }
}

main().catch(console.error);
