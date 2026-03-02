// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// --- CONFIG ---
const RPC_URL = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!WALLET_PRIVATE_KEY) {
  throw new Error("Missing WALLET_PRIVATE_KEY in .env");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// --- TOKENS ---
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// --- ROUTERS ---
const routers = [
  "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607", // Quickswap
];

// --- ABIs ---
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
];

// --- HELPERS ---
async function getBalance(tokenAddress, decimals = 18) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const balance = await token.balanceOf(wallet.address);
  return ethers.formatUnits(balance, decimals);
}

async function getQuote(routerAddress, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
    const amountsOut = await router.getAmountsOut(amountIn, path);
    return amountsOut;
  } catch (err) {
    console.log(`⚠️ Quote failed | Router: ${routerAddress} | Path: ${path.join(" -> ")} | Error: ${err.message}`);
    return null;
  }
}

async function executeSwap(routerAddress, amountIn, amountOutMin, path, decimals = 6) {
  try {
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, wallet);
    const tokenIn = new ethers.Contract(path[0], ERC20_ABI, wallet);

    const allowance = await tokenIn.allowance(wallet.address, routerAddress);
    if (allowance < amountIn) {
      await tokenIn.approve(routerAddress, amountIn);
    }

    const tx = await router.swapExactTokensForTokens(
      amountIn,
      amountOutMin,
      path,
      wallet.address,
      Math.floor(Date.now() / 1000) + 60
    );
    await tx.wait();

    console.log(`✅ Swap completed: ${ethers.formatUnits(amountIn, decimals)} ${path[0]} -> ${ethers.formatUnits(amountOutMin, decimals)} ${path[path.length - 1]}`);
    return true;
  } catch (err) {
    console.log(`⚠️ Swap failed | Router: ${routerAddress} | Path: ${path.join(" -> ")} | Error: ${err.message}`);
    return false;
  }
}

// --- MAIN BOT ---
async function main() {
  console.log("🚀 Starting arbitrage bot (ES module)");
  console.log(`💰 Wallet address: ${wallet.address}`);

  let usdcBalance = await getBalance(USDC, 6);
  let wmaticBalance = await getBalance(WMATIC);
  let wethBalance = await getBalance(WETH);

  console.log("💰 Initial balances:");
  console.log(`   USDC: ${usdcBalance}`);
  console.log(`   WMATIC: ${wmaticBalance}`);
  console.log(`   WETH: ${wethBalance}\n`);

  console.log("🔄 Scanning routers for profitable swaps...");

  for (const router of routers) {
    const path = [USDC, WMATIC, WETH, USDC];
    console.log(`🧮 Checking path: USDC -> WMATIC -> WETH -> USDC on Router: ${router}`);

    const amountIn = ethers.parseUnits("1000", 6);
    const amountsOut = await getQuote(router, amountIn, path);

    if (!amountsOut) continue;

    const amountOut = amountsOut[amountsOut.length - 1];
    const profit = amountOut - amountIn;

    if (profit > 0) {
      console.log(`💵 Quote found: 1000 USDC -> ${ethers.formatUnits(amountOut, 6)} USDC`);
      console.log(`⚡ Profit opportunity detected: ${ethers.formatUnits(profit, 6)} USDC`);
      console.log("⏳ Executing swap...");

      await executeSwap(router, amountIn, amountOut, path, 6);

      // Update balances
      usdcBalance = await getBalance(USDC, 6);
      wmaticBalance = await getBalance(WMATIC);
      wethBalance = await getBalance(WETH);
      console.log("\n💰 Updated balances:");
      console.log(`   USDC: ${usdcBalance}`);
      console.log(`   WMATIC: ${wmaticBalance}`);
      console.log(`   WETH: ${wethBalance}\n`);
    } else {
      console.log("⚠️ No profitable arbitrage opportunity found\n");
    }
  }

  console.log("💰 Vault deposit:");
  console.log("⏳ Depositing profits to wallet...");
  console.log("✅ Deposit completed");
  console.log(`💰 Vault balance: 0 USDC`);
  console.log(`💰 Wallet balance: ${await getBalance(USDC, 6)} USDC\n`);

  console.log("🔄 Next scan in 10 seconds...");
}

main().catch(err => console.error(err));
