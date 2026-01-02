// scripts/arbitrage.js
import { ethers } from "ethers";

// ---------------------- CONFIG -----------------------------
const RPC_URL = "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TRADE_AMOUNT_USDC = 0.1; // 0.1 USDC
const MIN_RETURN_USDC = 0.001; // 0.001 USDC minimum profit
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
  "function approve(address spender,uint256 value) returns (bool)"
];

// ---------------------- PROVIDER & WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ---------------------- BASE TOKEN ADDRESSES ----------------
const WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const WBTC_ADDRESS = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";
const MATIC_ADDRESS = "0x0000000000000000000000000000000000001010"; // Native MATIC on Polygon

const baseTokens = []; // Will populate after vault USDC fetch

// ---------------------- UTILITIES ------------------------
async function getUSDCBalance() {
  const usdcAddress = await vault.USDC();
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
  return await usdc.balanceOf(VAULT_ADDRESS); // bigint
}

// Convert number USDC to 6-decimal BigInt
function usdc(amount) {
  return BigInt(Math.floor(amount * 1e6));
}

// Format BigInt USDC to human-readable string
function formatUSDC(amountBigInt) {
  return (Number(amountBigInt) / 1e6).toFixed(6);
}

// Get wallet MATIC balance
async function getWalletMaticBalance() {
  const balance = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(balance));
}

// ---------------------- FALLBACK PATH LOGIC -----------------
async function findBestPath(amountIn, token, routers) {
  for (let routerAddress of routers) {
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);

    // Try all base tokens for 1-hop or 2-hop swaps
    for (let base of baseTokens) {
      if (base === token) continue;

      const paths = [
        [token, base],          // token -> base
        [token, base, baseTokens[0]] // token -> base -> USDC
      ];

      for (let path of paths) {
        try {
          const amounts = await router.getAmountsOut(amountIn, path);
          const expectedOut = amounts[amounts.length - 1];
          if (expectedOut > 0) {
            return { router: routerAddress, path, expectedOut };
          }
        } catch (err) {
          // Ignore failed path
          continue;
        }
      }
    }
  }
  return null; // no viable path
}

// ---------------------- ARBITRAGE EXECUTION --------------
async function executeArb(buyRouter, sellRouter, token, amountInUSDC, minReturnUSDC) {
  try {
    const vaultBalance = await getUSDCBalance();
    if (vaultBalance < amountInUSDC) {
      console.log("❌ Vault balance insufficient for trade");
      return;
    }

    // Build router list for fallback paths
    const routers = [buyRouter, sellRouter];

    // Find best buy path
    const bestBuy = await findBestPath(amountInUSDC, token, routers);
    if (!bestBuy) {
      console.log("❌ No viable buy path found");
      return;
    }

    // Find best sell path
    const bestSell = await findBestPath(bestBuy.expectedOut, token, routers);
    if (!bestSell) {
      console.log("❌ No viable sell path found");
      return;
    }

    // Calculate expected profit
    const profit = bestSell.expectedOut - amountInUSDC;
    if (profit < minReturnUSDC) {
      console.log(`❌ Expected profit ${formatUSDC(profit)} < minReturnUSDC ${formatUSDC(minReturnUSDC)}. Skipping.`);
      return;
    }

    // Log expected swap details
    console.log("🔍 Attempting arbitrage...");
    console.log(`💰 Expected buy: ${formatUSDC(amountInUSDC)} USDC -> ${bestBuy.expectedOut} token`);
    console.log(`💵 Expected sell: ${bestBuy.expectedOut} token -> ${formatUSDC(bestSell.expectedOut)} USDC`);
    console.log(`💸 Expected profit: ${formatUSDC(profit)} USDC`);
    console.log(`🏦 Wallet MATIC balance: ${await getWalletMaticBalance()}`);

    // Execute arbitrage
    const tx = await vault.executeArbitrage(
      bestBuy.router,
      bestSell.router,
      token,
      amountInUSDC,
      minReturnUSDC,
      { gasLimit: 800_000 }
    );

    console.log(`✅ Arbitrage tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`🎯 Arbitrage confirmed in block ${receipt.blockNumber}`);
    const vaultAfter = await getUSDCBalance();
    console.log(`🏦 Vault USDC after: ${formatUSDC(vaultAfter)}`);

  } catch (err) {
    console.log("⚠️ Execution failed:", err.message);
  }
}

// ---------------------- SCAN & TRADE ----------------------
async function scanAndTrade() {
  const buyRouter = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // Sushi
  const sellRouter = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap
  const token = "0x172370d5cd63279efa6d502dab29171933a610af"; // Example token

  // Update base tokens after fetching USDC
  const usdcAddr = await vault.USDC();
  baseTokens.length = 0;
  baseTokens.push(usdcAddr, WETH_ADDRESS, WBTC_ADDRESS, MATIC_ADDRESS);

  const amountIn = usdc(TRADE_AMOUNT_USDC);
  const minReturn = usdc(MIN_RETURN_USDC);

  const vaultBal = await getUSDCBalance();
  console.log("🏦 Vault USDC:", formatUSDC(vaultBal));
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
