// arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const {
  RPC_URL,
  PRIVATE_KEY,
  VAULT_ADDRESS,
  USDC_ADDRESS
} = process.env;

// Router addresses
const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Minimal ABIs
const VAULT_ABI = [
  "function USDC() view returns(address)",
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external",
  "function approveRouter(address router,address token) external"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns(uint256)",
  "function approve(address spender,uint256 amount) returns(bool)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns(uint256[] memory)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) returns(uint256[] memory)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

async function approveRouterIfNeeded(routerAddress, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(VAULT_ADDRESS, routerAddress);
  if (allowance < ethers.parseUnits("1000000", 6)) { // arbitrary high amount
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
  } catch (err) {
    console.warn(`Failed getAmountsOut for ${routerAddress} -> ${tokenAddress}: ${err}`);
    return ethers.BigInt(0);
  }
}

async function getExpectedUSDCOut(routerAddress, tokenAmount, tokenAddress) {
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  const path = [tokenAddress, USDC_ADDRESS];
  try {
    const amounts = await router.getAmountsOut(tokenAmount, path);
    return amounts[amounts.length - 1];
  } catch (err) {
    console.warn(`Failed getAmountsOut for ${routerAddress} -> USDC: ${err}`);
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
      if (sellRouter === buyRouter) continue; // skip same router
      const usdcOut = await getExpectedUSDCOut(sellRouter, tokenOut, tokenAddress);
      if (usdcOut <= amountInUSDC) continue; // skip non-profitable

      const profit = usdcOut - amountInUSDC;
      if (profit > bestProfit) {
        bestProfit = profit;
        bestRoute = { buyRouter, sellRouter, buyName, sellName, tokenOut, usdcOut };
      }
    }
  }

  return bestRoute;
}

async function runArbitrage() {
  const vaultUSDCBalance = await (new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider)).balanceOf(VAULT_ADDRESS);
  if (vaultUSDCBalance <= 0) {
    console.log("Vault has no USDC");
    return;
  }

  const tradeAmount = vaultUSDCBalance / 10n; // use 10% per trade

  const TOKENS_TO_SCAN = [
    "0x172370d5cd63279efa6d502dab29171933a610af", // CRV
    "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
    "0xd6df932a45c0f255f85145f286ea0b292b21c90b"  // AAVE
  ];

  for (const token of TOKENS_TO_SCAN) {
    // Approve routers automatically
    for (const router of Object.values(ROUTERS)) {
      await approveRouterIfNeeded(router, token);
    }

    const arb = await findProfitableArb(token, tradeAmount);
    if (!arb) {
      console.log(`No profitable arbitrage for token ${token}`);
      continue;
    }

    console.log(`Profitable arbitrage found for token ${token}:`);
    console.log(`${arb.buyName} -> ${arb.sellName} | Expected profit: ${ethers.formatUnits(arb.usdcOut - tradeAmount, 6)} USDC`);

    try {
      const tx = await vault.executeArbitrage(
        arb.buyRouter,
        arb.sellRouter,
        token,
        tradeAmount,
        arb.tokenOut,
        arb.usdcOut,
        Math.floor(Date.now() / 1000) + 60 // 1 min deadline
      );
      await tx.wait();
      console.log("Arbitrage executed successfully!");
    } catch (err) {
      console.error("Arbitrage execution failed:", err);
    }
  }
}

// Continuous loop
async function main() {
  console.log("🚀 Live arbitrage runner started");
  while (true) {
    try {
      await runArbitrage();
      await new Promise(r => setTimeout(r, 5000)); // 5s delay
    } catch (err) {
      console.error("Error in main loop:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();
