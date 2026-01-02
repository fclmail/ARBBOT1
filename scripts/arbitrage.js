// scripts/arbitrage.js
import { ethers } from "ethers";

// ---------------------- CONFIG -----------------------------
const RPC_URL = "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

const TRADE_AMOUNT_USDC = 0.1; // 0.1 USDC
const MIN_RETURN_USDC = 0.001; // Minimum profit target
const DEADLINE_OFFSET = 60; // seconds
const DRY_RUN = true; // Toggle dry-run (simulate contract call without gas)

// ---------------------- INLINE ABIs ------------------------
const VAULT_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minReturnUSDC) external",
  "function USDC() view returns (address)"
];

const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts)",
  "function getAmountsOut(uint256 amountIn,address[] calldata path) view returns (uint256[] memory amounts)"
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)"
];

// ---------------------- PROVIDER & WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ---------------------- UTILITIES ------------------------
async function getUSDCBalance() {
  const usdcAddress = await vault.USDC();
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
  return await usdc.balanceOf(VAULT_ADDRESS); // returns bigint
}

function usdc(amount) {
  return BigInt(Math.floor(amount * 1e6)); // USDC has 6 decimals
}

function formatUSDC(amountBigInt) {
  return (Number(amountBigInt) / 1e6).toFixed(6);
}

// ---------------------- ARBITRAGE EXECUTION --------------
async function executeArb(buyRouterAddr, sellRouterAddr, tokenAddr, amountInUSDC, minReturnUSDC) {
  try {
    const vaultBalance = await getUSDCBalance();
    if (vaultBalance < amountInUSDC) {
      console.log("❌ Vault balance insufficient for trade");
      return;
    }

    // --- 1) Expected amounts for buy/sell ---
    const usdcAddr = await vault.USDC();
    const buyRouter = new ethers.Contract(buyRouterAddr, ROUTER_ABI, provider);
    const sellRouter = new ethers.Contract(sellRouterAddr, ROUTER_ABI, provider);

    let buyAmounts, sellAmounts, tokenAmount, expectedProfit;

    try {
      buyAmounts = await buyRouter.getAmountsOut(amountInUSDC, [usdcAddr, tokenAddr]);
      tokenAmount = buyAmounts[buyAmounts.length - 1];

      sellAmounts = await sellRouter.getAmountsOut(tokenAmount, [tokenAddr, usdcAddr]);
      expectedProfit = Number(sellAmounts[sellAmounts.length - 1] - amountInUSDC) / 1e6;
    } catch (err) {
      console.log("❌ No viable buy/sell path found");
      return;
    }

    console.log(`💰 Expected buy: ${Number(amountInUSDC) / 1e6} USDC -> ${Number(tokenAmount)} token`);
    console.log(`💵 Expected sell: ${Number(tokenAmount)} token -> ${Number(sellAmounts[sellAmounts.length - 1]) / 1e6} USDC`);
    console.log(`💸 Expected profit: ${expectedProfit.toFixed(6)} USDC`);

    // --- 2) Wallet MATIC balance for gas ---
    const walletBalance = await provider.getBalance(wallet.address);
    console.log(`🏦 Wallet MATIC balance: ${ethers.formatEther(walletBalance)}`);

    // --- 3) Dry-run contract-level call ---
    if (DRY_RUN) {
      try {
        await vault.callStatic.executeArbitrage(
          buyRouterAddr,
          sellRouterAddr,
          tokenAddr,
          amountInUSDC,
          minReturnUSDC
        );
        console.log("✅ Dry-run: transaction would PASS at contract level");
      } catch (err) {
        console.log("❌ Dry-run: transaction would REVERT at contract level", err.reason || err.message);
        return;
      }
    }

    // --- 4) Actual transaction ---
    const tx = await vault.executeArbitrage(
      buyRouterAddr,
      sellRouterAddr,
      tokenAddr,
      amountInUSDC,
      minReturnUSDC,
      { gasLimit: 800_000 } // adjust as needed
    );

    console.log(`✅ Arbitrage tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`🎯 Arbitrage confirmed in block ${receipt.blockNumber}`);

    const vaultAfter = await getUSDCBalance();
    console.log(`🏦 Vault USDC updated: ${formatUSDC(vaultAfter)}`);
  } catch (err) {
    console.log("⚠️ Execution failed:", err.message);
  }
}

// ---------------------- SCAN & TRADE ----------------------
async function scanAndTrade() {
  // Example routers & token paths (can extend for MATIC/USDC/WETH/WBTC)
  const buyRouter = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";  // SushiSwap
  const sellRouter = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap
  const token = "0x172370d5cd63279efa6d502dab29171933a610af";      // Example token (CRV)

  const amountIn = usdc(TRADE_AMOUNT_USDC);
  const minReturn = usdc(MIN_RETURN_USDC);

  const vaultBal = await getUSDCBalance();
  console.log("🏦 Vault USDC:", formatUSDC(vaultBal));
  console.log("🔍 Attempting arbitrage...");

  await executeArb(buyRouter, sellRouter, token, amountIn, minReturn);
}

// ---------------------- MAIN LOOP -------------------------
async function main() {
  console.log(`⏱ ${new Date().toISOString()} Polygon Arb Bot Started`);

  while (true) {
    try {
      await scanAndTrade();
      await new Promise(r => setTimeout(r, 10_000)); // 10s delay
    } catch (err) {
      console.error("Error in main loop:", err);
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
}

main();
