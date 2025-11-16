import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// ------------------------ CONFIG ------------------------
const RPC_URL = "***"; // Your RPC URL
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const DRY_RUN = true;

// ------------------------ LOAD ABI ------------------------
const abiPath = path.resolve("./artifacts/contracts/ArbContract.sol/ArbContract.json");
if (!fs.existsSync(abiPath)) {
  console.error("❌ ABI file not found at:", abiPath);
  process.exit(1);
}
const abiFile = fs.readFileSync(abiPath, "utf8");
const arbAbi = JSON.parse(abiFile);

// ------------------------ PROVIDER & CONTRACT ------------------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// ------------------------ DUMMY DATA ------------------------
// Replace with real token/router data
const pairs = [
  { token: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", buy: "QuickSwap", sell: "ApeSwap" },
  { token: "0xC02aaA39b223FE8D0a0e5C4F27eAD9083C756Cc2", buy: "SushiSwap", sell: "ApeSwap" },
];

// ------------------------ PROFIT TRACKING ------------------------
let cumulative = { profit: 0 };

// ------------------------ SIMULATE TRADE ------------------------
async function simulateTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    console.log(`\n🔍 Dry-run: Buy ${buyRouter} -> Sell ${sellRouter} | Token: ${tokenAddr} | Amount: ${amount}`);
    
    // Call static simulation
    const result = await arbContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), 6)
    );

    const profit = Number(ethers.formatUnits(result, 6));
    cumulative.profit += profit;
    console.log(`💹 Estimated Profit: ${profit.toFixed(6)} USDC | Cumulative: ${cumulative.profit.toFixed(6)} USDC`);
  } catch (err) {
    console.log("❌ CallStatic failed:", err.message || err);
  }
}

// ------------------------ MAIN LOOP ------------------------
async function main() {
  console.log("🚀 Starting ARB Bot — DRY_RUN =", DRY_RUN);
  console.log("🏛 RPC:", RPC_URL);
  console.log("🔗 Contract:", CONTRACT_ADDRESS);

  while (true) {
    for (const pair of pairs) {
      try {
        await simulateTrade(pair.buy, pair.sell, pair.token, 100); // example amount 100 USDC
      } catch (e) {
        console.log("⚠️ Skipped pair due to error:", e.message || e);
      }
    }

    console.log("⏱ Waiting 10 seconds before next scan...\n");
    await new Promise((res) => setTimeout(res, 10000));
  }
}

main().catch((err) => console.error("Fatal error:", err));
