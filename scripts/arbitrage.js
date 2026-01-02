// scripts/arbitrage.js
import { ethers } from "ethers";

// ---------------------- CONFIG -----------------------------
const RPC_URL = "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TRADE_AMOUNT_USDC = 10; // USDC amount to trade
const MIN_RETURN_USDC = 0.001; // minimum acceptable profit
const DEADLINE_OFFSET = 60; // seconds

// Base tokens for robust fallback paths
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const WBTC_ADDRESS = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";
const MATIC_ADDRESS = "0x0000000000000000000000000000000000001010"; // Polygon MATIC
const baseTokens = [USDC_ADDRESS, WETH_ADDRESS, WBTC_ADDRESS, MATIC_ADDRESS];

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
  return await usdc.balanceOf(VAULT_ADDRESS);
}

async function getWalletMatic() {
  return await provider.getBalance(wallet.address);
}

function usdc(amount) {
  return BigInt(Math.floor(amount * 1e6));
}

function formatUSDC(amountBigInt) {
  return (Number(amountBigInt) / 1e6).toFixed(6);
}

function formatToken(amountBigInt, decimals = 18) {
  return (Number(amountBigInt) / 10 ** decimals).toFixed(18);
}

// ---------------------- PATH UTILITY ---------------------
async function findBestPath(amountIn, token, routers) {
  for (let routerAddress of routers) {
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);

    for (let base of baseTokens) {
      if (base === token) continue;

      const paths = [
        [token, base],
        [token, base, USDC_ADDRESS],
        [token, WETH_ADDRESS, USDC_ADDRESS],
        [token, WBTC_ADDRESS, USDC_ADDRESS],
        [token, MATIC_ADDRESS, USDC_ADDRESS]
      ];

      for (let path of paths) {
        try {
          const amounts = await router.getAmountsOut(amountIn, path);
          const expectedOut = amounts[amounts.length - 1];
          if (expectedOut > 0) {
            return { router: routerAddress, path, expectedOut };
          }
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

// ---------------------- ARBITRAGE EXECUTION --------------
async function executeArb(buyRouter, sellRouter, token, amountInUSDC, minReturnUSDC) {
  try {
    const vaultBalance = await getUSDCBalance();
    const walletMatic = await getWalletMatic();

    if (vaultBalance < amountInUSDC) {
      console.log("❌ Vault balance insufficient for trade");
      return;
    }

    const buyRouterObj = new ethers.Contract(buyRouter, ROUTER_ABI, provider);
    const sellRouterObj = new ethers.Contract(sellRouter, ROUTER_ABI, provider);

    // --- Estimate Buy ---
    let buyAmounts;
    try {
      buyAmounts = await buyRouterObj.getAmountsOut(amountInUSDC, [USDC_ADDRESS, token]);
    } catch {
      console.log("❌ No viable buy path found");
      return;
    }
    const expectedToken = buyAmounts[buyAmounts.length - 1];

    // --- Estimate Sell ---
    const sell = await findBestPath(expectedToken, token, [sellRouter]);
    if (!sell) {
      console.log("❌ No viable sell path found");
      return;
    }

    const expectedProfit = Number(sell.expectedOut) / 1e6 - Number(amountInUSDC) / 1e6;

    console.log(`🏦 Vault USDC: ${formatUSDC(vaultBalance)}`);
    console.log("🔍 Attempting arbitrage...");
    console.log(`💰 Expected buy: ${Number(amountInUSDC)/1e6} USDC -> ${formatToken(expectedToken)} token`);
    console.log(`💵 Expected sell: ${formatToken(expectedToken)} token -> ${Number(sell.expectedOut)/1e6} USDC`);
    console.log(`💸 Expected profit: ${expectedProfit.toFixed(6)} USDC`);
    console.log(`🏦 Wallet MATIC balance: ${ethers.formatEther(walletMatic)}`);

    if (expectedProfit < Number(minReturnUSDC)/1e6) {
      console.log(`❌ Expected profit ${expectedProfit.toFixed(6)} < minReturnUSDC ${Number(minReturnUSDC)/1e6}. Skipping.`);
      return;
    }

    const tx = await vault.executeArbitrage(
      buyRouter,
      sell.router,
      token,
      amountInUSDC,
      minReturnUSDC,
      { gasLimit: 800_000 }
    );

    console.log(`✅ Arbitrage tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`🎯 Arbitrage confirmed in block ${receipt.blockNumber}`);

    // --- Post trade vault balance ---
    const vaultBalanceAfter = await getUSDCBalance();
    console.log(`🏦 Vault USDC after trade: ${formatUSDC(vaultBalanceAfter)}`);
  } catch (err) {
    console.log("⚠️ Execution failed:", err.message);
  }
}

// ---------------------- SCAN & TRADE ----------------------
async function scanAndTrade() {
  const buyRouter = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // Sushi
  const sellRouter = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap
  const token = "0x172370d5cd63279efa6d502dab29171933a610af"; // Example token

  const amountIn = usdc(TRADE_AMOUNT_USDC);
  const minReturn = usdc(MIN_RETURN_USDC);

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
