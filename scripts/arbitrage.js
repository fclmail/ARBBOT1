// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------------- CONFIG -----------------------------
const RPC_URL = "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TRADE_AMOUNT_USDC = 0.1; // 0.1 USDC
const MIN_RETURN_USDC = 0.001; // allow slippage
const DEADLINE_OFFSET = 60; // seconds

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
  "function approve(address spender,uint256 value) returns (bool)",
  "function decimals() view returns (uint8)"
];

// ---------------------- PROVIDER & WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ---------------------- UTILITIES ------------------------
async function getUSDCBalance() {
  const usdcAddress = await vault.USDC();
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
  return await usdc.balanceOf(VAULT_ADDRESS); // returns BigInt
}

// Convert number USDC to 6-decimal BigNumber
function usdc(amount) {
  return ethers.parseUnits(amount.toString(), 6);
}

// Format BigInt/BigNumber USDC to human-readable string
function formatUSDC(amount) {
  return (Number(ethers.formatUnits(amount, 6))).toFixed(6);
}

// ---------------------- ARBITRAGE EXECUTION --------------
async function executeArb(buyRouter, sellRouter, token, amountInUSDC, minReturnUSDC) {
  try {
    const vaultBalance = await getUSDCBalance();
    if (vaultBalance < amountInUSDC) {
      console.log("❌ Vault balance insufficient for trade");
      return;
    }

    // Get USDC contract
    const usdcAddress = await vault.USDC();
    const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

    // Build buy path: USDC -> token
    const pathBuy = [usdcAddress, token];
    const buyRouterContract = new ethers.Contract(buyRouter, ROUTER_ABI, provider);
    const sellRouterContract = new ethers.Contract(sellRouter, ROUTER_ABI, provider);

    // Compute expected buy amount
    const expectedBuy = await buyRouterContract.getAmountsOut(amountInUSDC, pathBuy);
    const expectedTokenAmount = expectedBuy[1];
    console.log(`💰 Expected buy: ${formatUSDC(amountInUSDC)} USDC -> ${ethers.formatUnits(expectedTokenAmount, 18)} token`);

    // Build sell path: token -> USDC
    const pathSell = [token, usdcAddress];
    const expectedSell = await sellRouterContract.getAmountsOut(expectedTokenAmount, pathSell);
    const expectedUSDCBack = expectedSell[1];
    console.log(`💵 Expected sell: ${ethers.formatUnits(expectedTokenAmount, 18)} token -> ${formatUSDC(expectedUSDCBack)} USDC`);

    // Execute arbitrage
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token,
      amountInUSDC,
      minReturnUSDC,
      { gasLimit: 1_200_000 }
    );

    console.log(`✅ Arbitrage tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`🎯 Arbitrage confirmed in block ${receipt.blockNumber}`);

    // Fetch post-trade vault balance
    const afterBalance = await usdc.balanceOf(VAULT_ADDRESS);
    const profit = afterBalance - vaultBalance;
    console.log(`📈 Vault USDC before: ${formatUSDC(vaultBalance)}, after: ${formatUSDC(afterBalance)}, profit: ${formatUSDC(profit)}`);

    // Wallet MATIC balance
    const walletBalance = await provider.getBalance(wallet.address);
    console.log(`🟣 Wallet MATIC: ${ethers.formatEther(walletBalance)} MATIC`);

  } catch (err) {
    console.log("⚠️ Execution failed:", err.message || err);
  }
}

// ---------------------- SCAN & TRADE ----------------------
async function scanAndTrade() {
  const buyRouter = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // Sushi
  const sellRouter = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap
  const token = "0x172370d5cd63279efa6d502dab29171933a610af"; // Example token

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
