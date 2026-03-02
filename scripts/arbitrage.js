// arbitrage.js
const { ethers } = require("ethers");

// --- CONFIGURATION ---
const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com/");
const walletPrivateKey = "YOUR_PRIVATE_KEY"; // replace with your wallet
const wallet = new ethers.Wallet(walletPrivateKey, provider);

// Routers
const routers = [
  "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap / SushiswapV2Router
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"  // QuickSwap
];

// Tokens
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC= "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH  = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// Hop paths (example)
const paths = [
  [USDC, WMATIC, WETH],
  [WETH, WMATIC, USDC]
];

// ERC20 ABI (minimal)
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// UniswapV2 Router ABI (minimal)
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)"
];

// --- HELPERS ---
async function approveToken(tokenAddress, spender, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (allowance.lt(amount)) {
    console.log(`Approving ${tokenAddress} for ${spender}...`);
    await token.approve(spender, amount);
  }
}

async function getWalletBalance(tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const balance = await token.balanceOf(wallet.address);
  return balance;
}

// --- ARBITRAGE LOOP ---
async function runArbitrage() {
  for (const routerAddress of routers) {
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, wallet);

    for (const path of paths) {
      try {
        const amountIn = ethers.utils.parseUnits("10", 6); // 10 USDC

        // Get quote
        const amountsOut = await router.getAmountsOut(amountIn, path);
        if (!amountsOut || amountsOut.length === 0) throw new Error("Invalid quote");
        const estimatedOut = ethers.BigNumber.from(amountsOut[amountsOut.length - 1]);

        console.log(`Quote on router ${routerAddress} | Path: ${path.join("->")} | Out: ${ethers.utils.formatUnits(estimatedOut, 18)}`);

        // Approve token for router
        await approveToken(path[0], routerAddress, amountIn);

        // Swap
        const tx = await router.swapExactTokensForTokens(
          amountIn,
          estimatedOut.mul(995).div(1000), // slippage 0.5%
          path,
          wallet.address, // profits back to wallet
          Math.floor(Date.now() / 1000) + 60 * 10 // 10 min deadline
        );

        console.log(`Swap submitted | Tx hash: ${tx.hash}`);
        await tx.wait();
        console.log(`Swap confirmed!`);

        // Check balances after swap
        const finalBalance = await getWalletBalance(path[path.length - 1]);
        console.log(`Wallet balance after swap: ${ethers.utils.formatUnits(finalBalance, 18)}`);
      } catch (err) {
        console.warn(`⚠️ Error | Router: ${routerAddress} | Path: ${path.join("->")} | ${err.message}`);
        continue;
      }
    }
  }
}

// --- MAIN ---
(async () => {
  console.log("Starting arbitrage bot...");
  while (true) {
    try {
      await runArbitrage();
      await new Promise(r => setTimeout(r, 5000)); // 5 sec delay
    } catch (err) {
      console.error(`Fatal error: ${err.message}`);
    }
  }
})();
