import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const RPC = process.env.POLYGON_RPC;
const provider = new ethers.providers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const ARB_CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// --------- ABI ---------
const ARB_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
  "function withdrawProfit(address token) external",
  "function owner() view returns(address)"
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns(uint256)",
  "function decimals() view returns(uint8)"
];

// --------- CONTRACTS ---------
const arbContract = new ethers.Contract(ARB_CONTRACT_ADDRESS, ARB_ABI, wallet);
const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

// --------- HELPER FUNCTIONS ---------

// Get vault balance
async function getVaultBalance() {
  const balance = await usdcContract.balanceOf(ARB_CONTRACT_ADDRESS);
  const decimals = await usdcContract.decimals();
  return balance / (10 ** decimals);
}

// Log vault balance
async function logVaultBalance(label = "") {
  const vaultBalance = await getVaultBalance();
  console.log(`🏦 Vault Balance ${label}: ${vaultBalance.toFixed(6)} USDC`);
}

// Execute single arbitrage trade and log profit
async function executeTrade(buyRouter, sellRouter, token, amountIn, tokenSymbol) {
  try {
    const vaultBalanceBefore = await getVaultBalance();

    console.log(`🔹 Executing trade ${tokenSymbol} | Amount In: ${amountIn}`);
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, token, amountIn);
    await tx.wait();

    const vaultBalanceAfter = await getVaultBalance();
    const netProfit = vaultBalanceAfter - vaultBalanceBefore;

    if (netProfit > 0) {
      console.log(`💰 Trade Profit: ${netProfit.toFixed(6)} USDC`);
      console.log(`🏦 Vault Balance After Trade: ${vaultBalanceAfter.toFixed(6)} USDC`);
    } else {
      console.log(`⚠️ No profit from this trade`);
    }

  } catch (err) {
    console.error("❌ Trade failed:", err);
  }
}

// Withdraw profit to owner wallet
async function withdrawUSDCProfit() {
  try {
    const tx = await arbContract.withdrawProfit(USDC_ADDRESS);
    await tx.wait();
    console.log("✅ Withdrawn all USDC profit to owner wallet");
    await logVaultBalance("After Withdrawal");
  } catch (err) {
    console.error("❌ Withdraw failed:", err);
  }
}

// --------- MAIN LOOP ---------
async function runArbitrage() {
  console.log("🚀 Starting ARB J's bot in LIVE MODE");
  await logVaultBalance("Initial");

  // Example tokens & routers (replace with your actual token/router pairs)
  const trades = [
    { buyRouter: "0x1...", sellRouter: "0x2...", token: "0xA...", symbol: "AAVE", amountIn: ethers.utils.parseUnits("1000", 6) },
    { buyRouter: "0x1...", sellRouter: "0x3...", token: "0xB...", symbol: "CRV", amountIn: ethers.utils.parseUnits("500", 6) },
    { buyRouter: "0x2...", sellRouter: "0x3...", token: "0xC...", symbol: "LINK", amountIn: ethers.utils.parseUnits("200", 6) }
  ];

  for (let trade of trades) {
    await executeTrade(trade.buyRouter, trade.sellRouter, trade.token, trade.amountIn, trade.symbol);
  }

  console.log("🚀 Arbitrage loop completed");
  await logVaultBalance("Final");
}

// Run
(async () => {
  await runArbitrage();

  // Optional: Withdraw profits to wallet
  // await withdrawUSDCProfit();
})();
