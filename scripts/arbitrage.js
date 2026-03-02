// scripts/arbitrage.js
import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

// ------------------ CONFIG ------------------
const DRY_RUN = process.env.DRY_RUN === "true";
const MIN_EXPECTED_PROFIT = parseFloat(process.env.MIN_EXPECTED_PROFIT || "0.00001"); // USDC
const SCAN_DELAY_MS = parseInt(process.env.SCAN_DELAY_MS || "4000");

// ------------------ PROVIDER & WALLET ------------------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ------------------ TOKENS ------------------
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
};

// ------------------ ROUTERS ------------------
const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

// ------------------ VAULT ------------------
let vaultUSDC = 0.509167; // example initial balance

// ------------------ ROUTER SUPPORT MAP ------------------
const SUPPORTED_TOKENS = {
  [ROUTERS.QuickSwap]: [TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC, TOKENS.WETH],
  [ROUTERS.SushiSwap]: [TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC, TOKENS.WETH],
  [ROUTERS.ApeSwap]: [TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC, TOKENS.WETH],
};

// ------------------ ERC20 ABI ------------------
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// ------------------ ROUTER ABI ------------------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory)"
];

// ------------------ UTILS ------------------
function isPathSupported(router, path) {
  const supported = SUPPORTED_TOKENS[router];
  return path.every(token => supported.includes(token)) && new Set(path).size === path.length;
}

async function getQuote(routerAddress, path, amountIn) {
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  try {
    if (!isPathSupported(routerAddress, path)) return null;
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch (err) {
    console.warn(`⚠️ Quote failed | Router: ${routerAddress} | Path: ${path.join("->")} | Error: ${err.message}`);
    return null;
  }
}

async function performSwap(routerAddress, path, amountIn) {
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 60; // 1 min expiry
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    const minOut = amounts[amounts.length - 1].mul(995).div(1000); // 0.5% slippage
    if (DRY_RUN) {
      console.log(`💸 Dry run swap | Router: ${routerAddress} | Path: ${path.join("->")} | AmountIn: ${amountIn}`);
      return;
    }
    const tx = await router.swapExactTokensForTokens(amountIn, minOut, path, wallet.address, deadline);
    await tx.wait();
    console.log(`✅ Swap executed | Router: ${routerAddress} | Path: ${path.join("->")}`);
  } catch (err) {
    console.warn(`⚠️ Swap failed | Router: ${routerAddress} | Path: ${path.join("->")} | Error: ${err.message}`);
  }
}

// ------------------ ARBITRAGE LOGIC ------------------
async function scanAndTrade() {
  console.log(`💰 Vault USDC balance: ${vaultUSDC} USDC`);

  const tradeAmount = ethers.parseUnits("0.01", 6); // 0.01 USDC for example

  // Example paths (keep your original hops)
  const paths = [
    [TOKENS.USDC, TOKENS.USDT],
    [TOKENS.USDC, TOKENS.WMATIC, TOKENS.USDT],
    [TOKENS.USDT, TOKENS.WETH, TOKENS.USDC]
  ];

  for (const router of Object.values(ROUTERS)) {
    for (const path of paths) {
      const quote = await getQuote(router, path, tradeAmount);
      if (quote && parseFloat(ethers.formatUnits(quote, 6)) > MIN_EXPECTED_PROFIT) {
        await performSwap(router, path, tradeAmount);
        vaultUSDC += parseFloat(ethers.formatUnits(quote, 6));
      }
    }
  }
}

// ------------------ MAIN LOOP ------------------
async function main() {
  console.log("🚀 Arbitrage bot started");
  console.log(`DRY_RUN=${DRY_RUN} | MIN_EXPECTED_PROFIT=${MIN_EXPECTED_PROFIT} USDC | SCAN_DELAY_MS=${SCAN_DELAY_MS}`);

  while (true) {
    await scanAndTrade();
    await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
  }
}

main().catch(err => console.error(err));
