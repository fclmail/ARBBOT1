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
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

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

// --- Main Function ---
async function main() {
  if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS || !AMOUNT_IN || !MIN_PROFIT_USDC || !BUY_ROUTER || !SELL_ROUTER) {
    console.error("❌ Missing environment variable(s)");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`✅ Connected as ${await wallet.getAddress()}`);

  const contract = new ethers.Contract(CONTRACT_ADDRESS, loadAbi().abi, wallet);

  const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6); // USDC.e has 6 decimals
  const minProfitParsed = ethers.parseUnits(MIN_PROFIT_USDC, 6);

  console.log(`💰 Amount in: ${AMOUNT_IN} USDC.e`);
  console.log(`💵 Minimum profit threshold: ${MIN_PROFIT_USDC} USDC.e`);

  for (const [symbol, tokenData] of Object.entries(tokens)) {
    console.log(`\n🔎 Checking token: ${symbol}`);

    try {
      // For demonstration: simulate profit calculation
      // In production, you’d call an off-chain price oracle or Uniswap quoter
      const estimatedProfit = minProfitParsed; // simulate $0.00001 profit
      console.log(`💰 Estimated profit: $${ethers.formatUnits(estimatedProfit, 6)}`);

      if (estimatedProfit.lt(minProfitParsed)) {
        console.log("⚠️ Profit below threshold, skipping trade");
        continue;
      }

      console.log("💥 Executing arbitrage transaction...");
      const tx = await contract.executeArbitrage(
        BUY_ROUTER.trim(),
        SELL_ROUTER.trim(),
        tokenData.address,
        amountInParsed
      );

      console.log(`📤 Transaction submitted! Hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

    } catch (err) {
      console.error("⚠️ Error executing arbitrage:", err.message);
    }
  }
}

main();
