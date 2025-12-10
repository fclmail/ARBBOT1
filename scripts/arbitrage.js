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

// --------- DEX ROUTERS & TOKENS ---------
// Restore all previous DEX routers and tokens
const DEXES = {
  QuickSwap: "0xa5E0829CaCED8FFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607"
};

const TOKENS = {
  AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
  CRV:  "0x172370d5cd63279efa6d502dab29171933a610af",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  // Add more tokens if previously supported
};

// --------- HELPERS ---------
async function getVaultBalance() {
  const balance = await usdcContract.balanceOf(ARB_CONTRACT_ADDRESS);
  const decimals = await usdcContract.decimals();
  return balance / (10 ** decimals);
}

async function logVaultBalance(label = "") {
  const vaultBalance = await getVaultBalance();
  console.log(`🏦 Vault Balance ${label}: ${vaultBalance.toFixed(6)} USDC`);
}

async function executeTrade(buyRouter, sellRouter, token, amountIn, tokenSymbol) {
  try {
    const vaultBalanceBefore = await getVaultBalance();
    console.log(`🔹 Executing trade ${tokenSymbol} | Amount In: ${ethers.utils.formatUnits(amountIn, 6)}`);
    
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

  // Loop through all token and router combinations
  for (let tokenSymbol in TOKENS) {
    const tokenAddress = TOKENS[tokenSymbol];
    for (let buyName in DEXES) {
      for (let sellName in DEXES) {
        if (buyName === sellName) continue; // skip same-router trades

        const buyRouter = DEXES[buyName];
        const sellRouter = DEXES[sellName];

        const amountIn = ethers.utils.parseUnits("1000", 6); // example, adjust per token

        await executeTrade(buyRouter, sellRouter, tokenAddress, amountIn, tokenSymbol);
      }
    }
  }

  console.log("🚀 Arbitrage loop completed");
  await logVaultBalance("Final");

  // Optional: Withdraw profits
  // await withdrawUSDCProfit();
}

// Run bot
(async () => {
  await runArbitrage();
})();
