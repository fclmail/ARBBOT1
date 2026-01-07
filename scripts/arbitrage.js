// 🟢 arb.js: LowRevertArbVault arbitrage executor
import { ethers } from "ethers";

// ==================== CONFIG ====================
const RPC_URL = "https://polygon-bor.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // example

// Example routers
const SUSHISWAP = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const QUICKSWAP = "0xa5e0829caecd2012cce9d55e3c7e0c6a7a5c8a5d";

// ==================== PROVIDER & WALLET ====================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ==================== CONTRACT INSTANCES ====================
const usdc = new ethers.Contract(
  USDC_ADDRESS,
  [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)"
  ],
  wallet
);

const arbVault = new ethers.Contract(
  VAULT_ADDRESS,
  [
    "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline)",
    "function MIN_PROFIT() view returns (uint256)"
  ],
  wallet
);

// ==================== SIMULATION FUNCTION ====================
async function simulateProfit(token, amountUSDC, buyRouter, sellRouter) {
  // Placeholder simulation logic (replace with actual price check)
  // Example: return 0.000182 USDC profit
  // In production, query the DEXes and compute expected delta
  const simulatedProfits = {
    "CRV": 182n,  // 0.000182 USDC (6 decimals)
    "LINK": 240n, // 0.000240 USDC
    "AAVE": 31n   // 0.000031 USDC
  };
  return simulatedProfits[token] || 0n;
}

// ==================== EXECUTION FUNCTION ====================
async function executeArb(token, amountUSDC, buyRouter, sellRouter) {
  const minProfit = await arbVault.MIN_PROFIT();
  const profitSim = await simulateProfit(token, amountUSDC, buyRouter, sellRouter);

  console.log(`[SIM] ${token} ${profitSim} simulated profit`);

  // Filter tiny trades to prevent contract revert
  if (profitSim < minProfit) {
    console.log(`⛔ Skipping: Simulated profit ${profitSim} < MIN_PROFIT ${minProfit}`);
    return;
  }

  try {
    const deadline = Math.floor(Date.now() / 1000 + 60); // 60s deadline

    const tx = await arbVault.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountUSDC,
      0,      // minTokenOut
      0,      // minUSDCOut
      deadline
    );

    const receipt = await tx.wait();
    console.log(`✅ Arbitrage confirmed: ${token} Profit ${profitSim} | TxHash: ${receipt.transactionHash}`);
  } catch (err) {
    console.error(`❌ EXEC FAIL: ${err.reason || err.message}`);
  }
}

// ==================== MAIN LOOP ====================
async function main() {
  const tradeList = [
    { token: "CRV", amount: 100_000n, buyRouter: SUSHISWAP, sellRouter: QUICKSWAP },
    { token: "LINK", amount: 100_000n, buyRouter: SUSHISWAP, sellRouter: QUICKSWAP },
    { token: "AAVE", amount: 100_000n, buyRouter: QUICKSWAP, sellRouter: SUSHISWAP },
  ];

  for (const trade of tradeList) {
    await executeArb(trade.token, trade.amount, trade.buyRouter, trade.sellRouter);
    // Wait 4s between trades
    await new Promise(r => setTimeout(r, 4000));
  }
}

main().catch(console.error);
