import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------------------
// CONFIG
// ---------------------
const RPC = process.env.RPC_POLYGON; // Set in .env file
if (!RPC) throw new Error("RPC_POLYGON not defined in .env");

const provider = new ethers.providers.JsonRpcProvider(RPC);
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not defined in .env");

const wallet = new Wallet(WALLET_PRIVATE_KEY, provider);

// ---------------------
// Tokens & DEXes
// ---------------------
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  CRV: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0x3813e82e6f7098b9583FC0F33a962D02018B6803",
};

const DEXES = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57f7D7A678ff",
  SushiSwap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  ApeSwap: "0xC0788A3Ad43d79aa53B09c2EaCc313A787d1d607",
};

// ---------------------
// Vault state
// ---------------------
let vaultBalance = 0; // in USDC units

// ---------------------
// ABIs
// ---------------------
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
];

const UNISWAP_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
];

// ---------------------
// Helper functions
// ---------------------
async function swap(routerAddress, fromToken, toToken, amountIn) {
  const router = new ethers.Contract(routerAddress, UNISWAP_ROUTER_ABI, wallet);
  const token = new ethers.Contract(fromToken, ERC20_ABI, wallet);

  // Approve router
  await token.approve(routerAddress, amountIn);

  const path = [fromToken, toToken];
  const deadline = Math.floor(Date.now() / 1000) + 120; // 2 min
  const tx = await router.swapExactTokensForTokens(
    amountIn,
    1, // min amount out, adjust as needed
    path,
    wallet.address,
    deadline
  );
  await tx.wait();

  const outToken = new ethers.Contract(toToken, ERC20_ABI, wallet);
  const outBalance = await outToken.balanceOf(wallet.address);
  return outBalance;
}

function formatUSDC(amount) {
  return ethers.utils.formatUnits(amount, 6);
}

// ---------------------
// Arbitrage runner
// ---------------------
async function runArbitrage() {
  console.log("🚀 Starting arbitrage runner...");

  for (const tokenSymbol in TOKENS) {
    const tokenAddress = TOKENS[tokenSymbol];

    for (const buyDex in DEXES) {
      for (const sellDex in DEXES) {
        if (buyDex === sellDex) continue;

        const buyRouter = DEXES[buyDex];
        const sellRouter = DEXES[sellDex];

        try {
          const amountIn = ethers.utils.parseUnits("1000", 6); // 1000 USDC
          console.log(`${tokenSymbol} | ${buyDex} → ${sellDex} | amount: 1000 USDC`);

          // Swap USDC → Token
          const tokenOutBalance = await swap(buyRouter, TOKENS.USDC, tokenAddress, amountIn);

          // Swap Token → USDC
          const usdcBalanceAfter = await swap(sellRouter, tokenAddress, TOKENS.USDC, tokenOutBalance);

          const profit = usdcBalanceAfter.sub(amountIn);
          if (profit.gt(0)) {
            vaultBalance += parseFloat(formatUSDC(profit));
            console.log(`✅ Profit: ${formatUSDC(profit)} USDC | Vault Balance: ${vaultBalance.toFixed(6)} USDC`);
          } else {
            console.log(`❌ No profit: ${formatUSDC(profit)} USDC`);
          }

        } catch (err) {
          console.log(`⚠️ Error on ${tokenSymbol} ${buyDex}→${sellDex}: ${err.message}`);
        }
      }
    }
  }
}

// ---------------------
// Main
// ---------------------
(async () => {
  await runArbitrage();
  console.log("🏦 Final Vault Balance:", vaultBalance.toFixed(6), "USDC");
})();
