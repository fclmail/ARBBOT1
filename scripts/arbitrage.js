
// scripts/arbitrage.js
import { ethers } from "ethers";

// ---------------------- CONFIG -----------------------------
const RPC_URL = "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TRADE_AMOUNT_USDC = .15; // in USDC
const MIN_RETURN_USDC = 0.001; // in USDC
const DEADLINE_OFFSET = 60; // seconds
const DRY_RUN = true; // Toggle dry-run mode (true = simulation, false = actual tx)

// ---------------------- TOKENS -----------------------------
const TOKENS = [
  { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
  { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
  { symbol: "WMATIC", address: "0x0000000000000000000000000000000000001010" },
  { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" }
];

// Fallback DEX routers
const ROUTERS = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" }
];

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

async function getWalletMATIC() {
  return await provider.getBalance(wallet.address);
}

// Convert number USDC to 6-decimal BigInt
function usdc(amount) {
  return BigInt(Math.floor(amount * 1e6));
}

// Format BigInt USDC to human-readable string
function formatUSDC(amountBigInt) {
  return (Number(amountBigInt) / 1e6).toFixed(6);
}

// ---------------------- ARB CALCULATIONS -----------------
async function getSwapEstimate(routerAddress, path, amountIn) {
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

// ---------------------- ARBITRAGE EXECUTION --------------
async function executeArb(buyRouter, sellRouter, token, amountInUSDC, minReturnUSDC) {
  const vaultBalance = await getUSDCBalance();
  if (vaultBalance < amountInUSDC) {
    console.log("❌ Vault balance insufficient for trade");
    return;
  }

  // Build paths
  const usdcAddress = await vault.USDC();
  const pathBuy = [usdcAddress, token];
  const pathSell = [token, usdcAddress];

  // Expected amounts
  const expectedBuy = await getSwapEstimate(buyRouter, pathBuy, amountInUSDC);
  const expectedSell = expectedBuy ? await getSwapEstimate(sellRouter, pathSell, expectedBuy) : null;

  if (!expectedBuy || !expectedSell) {
    console.log("❌ No viable buy/sell path found");
    return;
  }

  const profit = Number(expectedSell - amountInUSDC) / 1e6;

  // Logging
  console.log(`💰 Expected buy: ${Number(amountInUSDC) / 1e6} USDC -> ${Number(expectedBuy) / 1e18} token`);
  console.log(`💵 Expected sell: ${Number(expectedBuy) / 1e18} token -> ${Number(expectedSell) / 1e6} USDC`);
  console.log(`💸 Expected profit: ${profit.toFixed(6)} USDC`);
  const maticBalance = await getWalletMATIC();
  console.log(`🏦 Wallet MATIC balance: ${ethers.formatEther(maticBalance)}`);

  if (DRY_RUN) {
    try {
      // Simulate transaction
      await vault.callStatic.executeArbitrage(buyRouter, sellRouter, token, amountInUSDC, minReturnUSDC);
      console.log("✅ Dry-run: transaction would PASS at contract level\n");
    } catch (err) {
      console.log("❌ Dry-run: transaction would REVERT at contract level\n");
    }
    return;
  }

  // Execute real transaction
  try {
    const tx = await vault.executeArbitrage(buyRouter, sellRouter, token, amountInUSDC, minReturnUSDC, { gasLimit: 500_000 });
    console.log(`✅ Arbitrage tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`🎯 Arbitrage confirmed in block ${receipt.blockNumber}\n`);
  } catch (err) {
    console.log("⚠️ Execution failed:", err.message, "\n");
  }
}

// ---------------------- SCAN & TRADE ----------------------
async function scanAndTrade() {
  const amountIn = usdc(TRADE_AMOUNT_USDC);
  const minReturn = usdc(MIN_RETURN_USDC);
  const vaultBal = await getUSDCBalance();
  console.log("🏦 Vault USDC:", formatUSDC(vaultBal));
  console.log("🔍 Attempting arbitrage...");

  for (const tokenObj of TOKENS) {
    for (const buyRouter of ROUTERS) {
      for (const sellRouter of ROUTERS) {
        if (buyRouter.address === sellRouter.address) continue; // skip same router
        await executeArb(buyRouter.address, sellRouter.address, tokenObj.address, amountIn, minReturn);
      }
    }
  }
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
