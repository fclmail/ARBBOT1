// arbitrage.js
import { ethers } from "ethers";

// ------------------- CONFIG -------------------

// RPC endpoint (Polygon Mainnet)
const RPC_URL = "https://polygon-rpc.com"; // you can replace with Alchemy/Infura RPC

// Your wallet private key (keep it secret)
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Vault contract
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

// USDC token on Polygon
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Routers
const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Tokens to scan (USDC pairs)
const TOKENS_TO_SCAN = [
  "0x172370d5cd63279efa6d502dab29171933a610af", // CRV
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
  "0xd6df932a45c0f255f85145f286ea0b292b21c90b"  // AAVE
];

// ------------------- ABIs -------------------

const VAULT_ABI = [
  "function USDC() view returns(address)",
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",
  "function approveRouter(address router,address token) external"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address owner, address spender) view returns(uint256)",
  "function approve(address spender,uint256 amount) returns(bool)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns(uint256[] memory)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) returns(uint256[] memory)"
];

// ------------------- PROVIDER & WALLET -------------------

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

// ------------------- HELPERS -------------------

async function approveRouterIfNeeded(routerAddress, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(VAULT_ADDRESS, routerAddress);
  if (allowance < ethers.parseUnits("1000000", 6)) {
    console.log(`Approving router ${routerAddress} for token ${tokenAddress} via vault`);
    const tx = await vault.approveRouter(routerAddress, tokenAddress);
    await tx.wait();
    console.log("Approval done");
  }
}

async function getExpectedTokenOut(routerAddress, amountInUSDC, tokenAddress) {
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  const path = [USDC_ADDRESS, tokenAddress];
  try {
    const amounts = await router.getAmountsOut(amountInUSDC, path);
    return amounts[amounts.length - 1];
  } catch {
    return ethers.BigInt(0);
  }
}

async function getExpectedUSDCOut(routerAddress, tokenAmount, tokenAddress) {
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  const path = [tokenAddress, USDC_ADDRESS];
  try {
    const amounts = await router.getAmountsOut(tokenAmount, path);
    return amounts[amounts.length - 1];
  } catch {
    return ethers.BigInt(0);
  }
}

async function findProfitableArb(tokenAddress, amountInUSDC) {
  let bestProfit = ethers.BigInt(0);
  let bestRoute = null;

  for (const [buyName, buyRouter] of Object.entries(ROUTERS)) {
    const tokenOut = await getExpectedTokenOut(buyRouter, amountInUSDC, tokenAddress);
    if (tokenOut <= 0) continue;

    for (const [sellName, sellRouter] of Object.entries(ROUTERS)) {
      if (sellRouter === buyRouter) continue;
      const usdcOut = await getExpectedUSDCOut(sellRouter, tokenOut, tokenAddress);
      if (usdcOut <= amountInUSDC) continue;

      const profit = usdcOut - amountInUSDC;
      if (profit > bestProfit) {
        bestProfit = profit;
        bestRoute = { buyRouter, sellRouter, buyName, sellName, tokenOut, usdcOut };
      }
    }
  }

  return bestRoute;
}

// ------------------- ARBITRAGE RUN -------------------

async function runArbitrage() {
  const vaultUSDCBalance = await (new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider)).balanceOf(VAULT_ADDRESS);
  if (vaultUSDCBalance <= 0) return console.log("Vault has no USDC");

  const tradeAmount = vaultUSDCBalance / 10n; // use 10% per trade

  for (const token of TOKENS_TO_SCAN) {
    // Ensure all routers are approved
    for (const router of Object.values(ROUTERS)) {
      await approveRouterIfNeeded(router, token);
    }

    const arb = await findProfitableArb(token, tradeAmount);
    if (!arb) {
      console.log(`No profitable arbitrage for token ${token}`);
      continue;
    }

    console.log(`Profitable arbitrage found for token ${token}: ${arb.buyName} -> ${arb.sellName}`);
    console.log(`Expected profit: ${ethers.formatUnits(arb.usdcOut - tradeAmount, 6)} USDC`);

    try {
      const tx = await vault.executeArbitrage(
        arb.buyRouter,
        arb.sellRouter,
        token,
        tradeAmount,
        arb.tokenOut,
        arb.usdcOut,
        Math.floor(Date.now() / 1000) + 60
      );
      await tx.wait();
      console.log("Arbitrage executed successfully!");
    } catch (err) {
      console.error("Arbitrage execution failed:", err);
    }
  }
}

// ------------------- MAIN LOOP -------------------

async function main() {
  console.log("🚀 Live arbitrage runner started");
  while (true) {
    try {
      await runArbitrage();
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      console.error("Error in main loop:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();
