import 'dotenv/config';
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// --- Load Environment Variables ---
const {
  RPC_URL,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  AMOUNT_IN,
  MIN_PROFIT_USDC,
  BUY_ROUTER,
  SELL_ROUTER
} = process.env;

// --- Token List ---
const tokens = {
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  KLIMA: { address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
};

// --- Constants ---
const USDCe = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC.e

// --- Validate environment ---
function validateEnv() {
  const required = { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, AMOUNT_IN, MIN_PROFIT_USDC, BUY_ROUTER, SELL_ROUTER };
  for (const [key, value] of Object.entries(required)) {
    if (!value || value.trim() === "") {
      console.error(`❌ Missing environment variable: ${key}`);
      process.exit(1);
    }
  }
}

// --- Load ABI ---
function loadAbi() {
  const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
  if (!fs.existsSync(abiPath)) {
    console.error(`❌ ABI file not found at: ${abiPath}`);
    process.exit(1);
  }
  try {
    const abiJSON = fs.readFileSync(abiPath, "utf-8");
    return JSON.parse(abiJSON);
  } catch (err) {
    console.error("❌ Error parsing ABI JSON:", err.message);
    process.exit(1);
  }
}

// --- Router ABI (Minimal) ---
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)"
];

// --- Main Function ---
async function main() {
  console.log("🚀 Starting Polygon Arbitrage Bot...");
  validateEnv();
  const abi = loadAbi();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`✅ Connected as ${await wallet.getAddress()}`);

  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi.abi, wallet);
  const buyRouter = new ethers.Contract(BUY_ROUTER, routerAbi, provider);
  const sellRouter = new ethers.Contract(SELL_ROUTER, routerAbi, provider);

  const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6); // USDC.e
  const minProfit = ethers.parseUnits(MIN_PROFIT_USDC, 6);

  console.log(`💰 Amount in: ${AMOUNT_IN} USDC.e`);
  console.log(`💵 Minimum profit threshold: ${MIN_PROFIT_USDC} USDC.e`);

  for (const [symbol, token] of Object.entries(tokens)) {
    try {
      console.log(`\n🔎 Checking token: ${symbol}`);

      const pathBuy = [USDCe, token.address];
      const pathSell = [token.address, USDCe];

      const amountsOutBuy = await buyRouter.getAmountsOut(amountInParsed, pathBuy);
      const tokenOut = amountsOutBuy[1];

      const amountsOutSell = await sellRouter.getAmountsOut(tokenOut, pathSell);
      const usdcOut = amountsOutSell[1];

      const profit = usdcOut - amountInParsed;
      const profitDisplay = Number(ethers.formatUnits(profit, 6));

      console.log(`💰 Estimated profit: ${profitDisplay.toFixed(8)} USDC.e`);

      if (profit <= 0n) {
        console.log("⚠️ No profit opportunity.");
        continue;
      }

      if (profit < minProfit) {
        console.log("⚠️ Profit below threshold, skipping trade");
        continue;
      }

      console.log("💥 Profit acceptable, executing arbitrage...");

      const tx = await contract.executeArbitrage(
        BUY_ROUTER,
        SELL_ROUTER,
        token.address,
        amountInParsed
      );

      console.log(`📤 Transaction submitted! Hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

    } catch (err) {
      console.error("⚠️ Error executing arbitrage:", err.message || err);
    }
  }
}

main();
