import { ethers } from "ethers";

// ------------------------ CONFIG ------------------------
const RPC_URL = "***"; // Your RPC URL
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const DRY_RUN = true;

// ------------------------ MINIMAL ABI ------------------------
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// ------------------------ PROVIDER & CONTRACT ------------------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// ------------------------ DUMMY DATA ------------------------
const pairs = [
  { token: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", buy: "0xRouterBuyAddress1", sell: "0xRouterSellAddress1" },
  { token: "0xC02aaA39b223FE8D0a0e5C4F27eAD9083C756Cc2", buy: "0xRouterBuyAddress2", sell: "0xRouterSellAddress2" }
];

// ------------------------ PROFIT TRACKING ------------------------
let cumulative = { profit: 0 };

// ------------------------ SIMULATE TRADE ------------------------
async function simulateTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    console.log(`\n🔍 Dry-run: Buy ${buyRouter} -> Sell ${sellRouter} | Token: ${tokenAddr} | Amount: ${amount}`);

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
        await simulateTrade(pair.buy, pair.sell, pair.token, 100);
      } catch (e) {
        console.log("⚠️ Skipped pair due to error:", e.message || e);
      }
    }

    console.log("⏱ Waiting 10 seconds before next scan...\n");
    await new Promise((res) => setTimeout(res, 10000));
  }
}

main().catch((err) => console.error("Fatal error:", err));
