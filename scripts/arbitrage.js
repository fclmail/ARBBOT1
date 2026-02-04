// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Vault Compatible)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ✅ NEW VAULT CONTRACT
const CONTRACT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

// minimum net profit (JS-side)
const MIN_NET_PROFIT_USDC = 0.000001;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── VAULT ABI (FIXED) ───────────────
const arbAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "uint256", name: "amountInUSDC", type: "uint256" },
      { internalType: "address[]", name: "pathToToken", type: "address[]" },
      { internalType: "address[]", name: "pathToUSDC", type: "address[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  // ✅ FIXED CHECKSUM
  Dfyn: "0xa8b607aa09b6a2641cf6f90f643e76d3f6e6ff73"
};

// ─────────────── TOKENS ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:  { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

// ─────────────── SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 0.2;
const MIN_PROFIT_PCT = 0.002;
const SLIPPAGE_PCT = 0;

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const usdcAddress = await arbContract.usdc();
  const path = [usdcAddress, token.address];

  const amounts = await router.getAmountsOut(
    ethers.parseUnits(amountIn.toString(), 6),
    path
  );

  return Number(
    ethers.formatUnits(amounts[amounts.length - 1], token.decimals)
  );
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const usdc = await arbContract.usdc();

    const amountIn = ethers.parseUnits(amount.toString(), 6);
    const pathToToken = [usdc, tokenAddr];
    const pathToUSDC = [tokenAddr, usdc];
    const deadline = Math.floor(Date.now() / 1000) + 60;

    const txData = await arbContract.populateTransaction.executeArbitrage(
      buyRouter,
      sellRouter,
      amountIn,
      pathToToken,
      pathToUSDC,
      deadline
    );

    const gasEstimate = await wallet.estimateGas(txData);
    const gasPrice = await provider.getGasPrice();

    if (TRADE_AMOUNT_USDC < MIN_NET_PROFIT_USDC) return;

    await arbContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      amountIn,
      pathToToken,
      pathToUSDC,
      deadline
    );

    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      amountIn,
      pathToToken,
      pathToUSDC,
      deadline,
      { gasLimit: gasEstimate * 2n }
    );

    console.log(`⏳ TX SENT: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ PROFIT DEPOSITED TO VAULT`);
  } catch (err) {
    console.error(`⚠️ Trade failed: ${err.reason || err.message}`);
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

          const profitUSDC = sellOut - buyOut;

          if (profitUSDC > MIN_NET_PROFIT_USDC) {
            console.log(
              `🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(profitUSDC)} USDC`
            );
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch {}
      }
    }
  }
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Vault Arbitrage Bot running on Polygon...");
  while (true) {
    await scan();
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);
