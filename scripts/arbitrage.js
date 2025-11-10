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

// ─────────────── ROUTERS (checksummed) ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76D3F6E6Ff73", // ✅ fixed checksum
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS ───────────────
const tokens = {
  AAVE:  { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:   { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:   { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  KLIMA: { address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LINK:  { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  UNI:   { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals: 18 },
  UNI2:  { address: "0xb33eaad8d922b1083446dc23f610c2567fb5180f", decimals: 18 },
  USDC:  { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  USDT:  { address: "0xC2132D05D31c914A87C6611C10748AEb04B58e8F", decimals: 6 },
  WBTC:  { address: "0x1BFD67037B42Cf73acf2047067bd4f2C47D9BfD6", decimals: 8 },
  WETH:  { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 }
};

// ─────────────── SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 10; // trade amount in USDC
const MIN_PROFIT_PCT = 5; // minimum profit %
const SLIPPAGE_PCT = 0;   // slippage %

const USDC_ADDRESS = tokens.USDC.address;
const usdcContract = new ethers.Contract(
  USDC_ADDRESS,
  ["function balanceOf(address) view returns (uint256)"],
  provider
);

function fmt(n, dec = 6) {
  return Number(n).toFixed(dec);
}

// ─────────────── GET AMOUNT OUT ───────────────
async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  try {
    const path = [tokens.USDC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path = [tokens.USDC.address, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    // 1️⃣ Check contract balance before
    const balanceBefore = await usdcContract.balanceOf(CONTRACT_ADDRESS);

    // 2️⃣ Simulate trade (callStatic)
    await arbContract.callStatic.executeArbitrage(
      buyRouter, sellRouter, tokenAddr,
      ethers.parseUnits(amount.toString(), tokens.USDC.decimals)
    );

    // 3️⃣ Send actual transaction
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr,
      ethers.parseUnits(amount.toString(), tokens.USDC.decimals),
      { gasLimit: 1_500_000 }
    );
    console.log(`⏳ Trade sent: ${tx.hash}`);
    await tx.wait();

    // 4️⃣ Check balance after
    const balanceAfter = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const profit = balanceAfter.sub(balanceBefore);

    // 5️⃣ Log success and profit
    console.log(`✅ Trade succeeded! Profit deposited: ${ethers.formatUnits(profit, 6)} USDC`);
  } catch (e) {
    console.error(`⚠️ Trade failed or reverted: ${e.message}`);
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

          let buyPrice = TRADE_AMOUNT_USDC / buyOut;
          let sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitPct = ((sellPrice - buyPrice) / buyPrice) * 100 * (1 - SLIPPAGE_PCT / 100);

          profitPct = Number(profitPct.toFixed(2));

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ token: symbol, buyName, sellName, profitPct });
            console.log(`🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(sellPrice - buyPrice)} USDC (${profitPct}%)`);

            await executeTrade(
              buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC
            );
          }

        } catch (err) {
          console.warn(`⚠️ Error ${symbol} ${buyName}->${sellName}: ${err.message}`);
        }
      }
    }
  }

  console.log(`Scan complete. Found ${opportunities.length} opportunities.`);
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
