// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Enhanced Logging)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Deployed contract

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ERC20 ABI (minimal) ───────────────
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

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
const TRADE_AMOUNT_USDC = 10; // Amount to borrow/trade
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
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path2 = [usdcAddress, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path2);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const txData = await arbContract.populateTransaction.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6)
    );

    // Estimate gas
    const gasEstimate = await wallet.estimateGas(txData);
    const gasPrice = await provider.getGasPrice();
    const gasCostUSDC = Number(ethers.formatUnits(gasEstimate.mul(gasPrice), 6));

    // Compute buy/sell for logging
    const buyOut = await getAmountOut(buyRouter, tokens.AAVE, amount); // Replace token dynamically if needed
    const sellOut = await getAmountOut(sellRouter, tokens.AAVE, amount);
    const buyPrice = amount / buyOut;
    const sellPrice = amount / sellOut;
    const estimatedProfit = sellPrice - buyPrice;
    const netProfit = estimatedProfit - gasCostUSDC;

    console.log(`🚨 Trade opportunity detected!`);
    console.log(`💸 Estimated gas cost: ${fmt(gasCostUSDC)} USDC`);
    console.log(`💰 Estimated profit: ${fmt(estimatedProfit)} USDC`);
    console.log(`🧾 Net profit after gas: ${fmt(netProfit)} USDC`);
    console.log(`🔹 Buy: ${buyRouter} @ $${fmt(buyPrice)} → Sell: ${sellRouter} @ $${fmt(sellPrice)}`);

    // Execute transaction
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), 6),
      { gasLimit: gasEstimate.mul(2) }
    );
    console.log(`⏳ Trade sent: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ Trade executed successfully!`);

    // Check profits retained in contract
    const usdcAddress = await arbContract.USDC();
    const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, provider);
    const contractBalance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    console.log(`🏦 Profits retained in contract: ${fmt(Number(ethers.formatUnits(contractBalance, 6)))} USDC`);

  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${err.reason || err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;

          let estimatedProfit = sellPrice - buyPrice;
          const slippageAdj = 1 - SLIPPAGE_PCT / 100;
          estimatedProfit *= slippageAdj;

          const profitPct = (estimatedProfit / buyPrice) * 100;

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Estimated profit: ${fmt(estimatedProfit)} USDC (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }
  console.log("🔍 Scan complete.\n");
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 40000)); // 40s delay
  }
}

main().catch(console.error);



