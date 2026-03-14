import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const RPC_POLYGON =
  (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();
const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();
const VAULT_CONTRACT_ADDRESS =
  (process.env.VAULT_CONTRACT_ADDRESS || "").trim(); // Your deployed VaultArbitrageEnforcer
const USDC_ADDRESS =
  (process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174").trim(); // Polygon USDC

/* ================= SETTINGS ================= */
const MIN_TRADE_USDC = 0.01;       // Minimum trade size
const MIN_PROFIT_USDC = 0.000001;      // Minimum profit per trade
const TARGET_BATCH_SIZE = 2;         // Partial batch size
const DEADLINE_SECONDS = 300;          // Swap deadline 5 min

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= VAULT CONTRACT ABI ================= */
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,uint256 amountInUSDC,address[] calldata pathToToken,address[] calldata pathToUSDC,uint256 deadline) external",
  "function usdc() view returns (address)",
  "function vault() view returns (address)"
];

const vault = new ethers.Contract(VAULT_CONTRACT_ADDRESS, vaultAbi, wallet);

/* ================= SAMPLE TRADES (RESTORED DEXES, TOKENS, HOP PATHS) ================= */
const trades = [
  {
    buyRouter: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",  // SushiSwap
    sellRouter: "0xa5e0829caecd60d7f8a2a52fdf2a4c1a4a1fdd1b", // QuickSwap
    amountIn: 0.05 * 1e6,
    bestBuyPath: [USDC_ADDRESS, "0xToken1Address"],
    bestSellPath: ["0xToken1Address", USDC_ADDRESS]
  },
  {
    buyRouter: "0xa5e0829caecd60d7f8a2a52fdf2a4c1a4a1fdd1b",  // QuickSwap
    sellRouter: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", // SushiSwap
    amountIn: 0.1 * 1e6,
    bestBuyPath: [USDC_ADDRESS, "0xToken2Address"],
    bestSellPath: ["0xToken2Address", USDC_ADDRESS]
  },
  // ... add all your trades here
];

/* ================= EXECUTE BATCH ================= */
async function executeBatch(trades) {
  console.log(`\nCollected trades: ${trades.length}`);

  const expanded = trades.slice(0, TARGET_BATCH_SIZE);
  console.log(`Compressed: ${expanded.length}`);
  console.log("Executing batch...\n");

  let swapsExecuted = 0;
  let swapsFailed = 0;
  let totalProfit = 0;

  for (const t of expanded) {
    if (t.amountIn < MIN_TRADE_USDC * 1e6) continue; // Skip tiny trades

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

    try {
      const tx = await vault.executeArbitrage(
        t.buyRouter,
        t.sellRouter,
        ethers.parseUnits(t.amountIn.toString(), 6), // USDC 6 decimals
        t.bestBuyPath,
        t.bestSellPath,
        deadline,
        { gasLimit: 5_000_000 }
      );

      swapsExecuted++;

      console.log(
        `Swap executed | buy: ${t.buyRouter} | sell: ${t.sellRouter} | amount: ${t.amountIn}`
      );

      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed.toString();
      console.log(`Transaction sent: ${tx.hash}`);
      console.log(`Transaction confirmed | Gas used: ${gasUsed}`);

      // Estimate profit from vault contract USDC balance difference
      // For demo, add trade.amountIn * 0.01% as sample profit
      totalProfit += t.amountIn * 0.01; // Replace with actual on-chain reading if needed

    } catch (err) {
      swapsFailed++;
      console.error(`Swap failed | buy: ${t.buyRouter} | sell: ${t.sellRouter}`, err);
    }
  }

  console.log("\nBatch summary:");
  console.log(`Swaps executed: ${swapsExecuted}`);
  console.log(`Swaps failed: ${swapsFailed}`);
  console.log(`Total profit: ${totalProfit.toFixed(6)} USDC`);
}

/* ================= RUN ================= */
(async () => {
  try {
    await executeBatch(trades);
  } catch (err) {
    console.error("Error running batch:", err);
  }
})();
