// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Full ABI + Gas Checks)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Hardcoded contract
const MIN_NET_PROFIT_USDC = 1; // Only execute if profit after gas > $1

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── FULL CONTRACT ABI ───────────────
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

// ─────────────── SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 10; // per trade
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path2 = [usdcAddress, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), 6),
      path2
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── EXECUTE TRADE WITH GAS CHECK ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const txData = await arbContract.populateTransaction.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), 6)
    );

    // Estimate gas
    const gasEstimate = await wallet.estimateGas(txData);
    const gasPrice = await provider.getGasPrice();
    const gasCostUSDC = Number(ethers.formatUnits(gasEstimate.mul(gasPrice), 6));

    console.log(`💸 Estimated gas cost: ${fmt(gasCostUSDC)} USDC`);

    // Check if trade net profit > MIN_NET_PROFIT_USDC
    if (TRADE_AMOUNT_USDC < gasCostUSDC + MIN_NET_PROFIT_USDC) {
      console.log(`⚠️ Skipping trade, estimated gas > profit`);
      return;
    }

    // CallStatic to simulate execution
    await arbContract.callStatic.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
    );

    // Send transaction
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6),
      { gasLimit: gasEstimate.mul(2) } // slight buffer
    );
    console.log(`⏳ Trade sent: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ Trade executed successfully!`);
  } catch (err) {
    console.error(`⚠️ Trade failed: ${err.reason || err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
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
          profitUSDC *= (1 - SLIPPAGE_PCT / 100);
          profitPct *= (1 - SLIPPAGE_PCT / 100);

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ token: symbol, buyName, sellName, profitUSDC, profitPct });
            console.log(`🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e.message}`);
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
