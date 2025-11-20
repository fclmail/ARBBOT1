import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// -------------------------- CONFIG --------------------------
const CONFIG = {
  RPC_URL: process.env.RPC_URL || "https://polygon-rpc.com/",
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  ARB_CONTRACT_ADDRESS: process.env.ARB_CONTRACT_ADDRESS,
  VAULT_ADDRESS: process.env.VAULT_ADDRESS,
  USDC_ADDRESS: process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDC_DECIMALS: 6,
  TOKEN_PAIRS: [
    { base: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", quote: process.env.USDC_ADDRESS }, // AAVE/USDC
    { base: "0x172370d5cd63279efa6d502dab29171933a610af", quote: process.env.USDC_ADDRESS }, // CRV/USDC
  ],
  DEXES: [
    { name: "QuickSwap", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
    { name: "SushiSwap", router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
    { name: "ApeSwap", router: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" },
  ],
  MIN_NET_PROFIT_USDC: 0.01,
  MIN_PROFIT_PCT: 0.5,
  SLIPPAGE_PCT: 0.2,
  SCAN_INTERVAL_MS: 10000,
  LOG_FILE: "arbjs_production.log",
  DRY_RUN: false
};

// -------------------------- SETUP --------------------------
const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
const arbContract = new ethers.Contract(CONFIG.ARB_CONTRACT_ADDRESS, [
  "function executeArbitrage(address[] memory path, address[] memory routers, uint256 amountIn) payable returns (bool)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)"
], wallet);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// -------------------------- HELPERS --------------------------
let cumulativeProfit = 0;

function fmt(n, dec = 4) { return Number(n).toFixed(dec); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getTokenDecimals(tokenAddr) {
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    return Number(await c.decimals());
  } catch { return 18; }
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch {
    const fallback = [usdcAddress, CONFIG.TOKEN_PAIRS[1].base, token.address];
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountIn.toString(), 6), fallback);
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

async function getVaultBalanceUSDC() {
  try {
    const usdc = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, provider);
    const bal = await usdc.balanceOf(CONFIG.VAULT_ADDRESS);
    return Number(ethers.formatUnits(bal, CONFIG.USDC_DECIMALS));
  } catch { return null; }
}

function log(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  console.log(entry);
  fs.appendFileSync(CONFIG.LOG_FILE, entry + "\n");
}

// -------------------------- EXECUTION --------------------------
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    // Read vault before
    const before = await getVaultBalanceUSDC();
    if (before === null) return;

    // Simulate tx as owner
    const path = [tokenAddr, CONFIG.USDC_ADDRESS];
    const routers = [buyRouter, sellRouter];
    try {
      await provider.call({
        to: CONFIG.ARB_CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [path, routers, ethers.parseUnits(amount.toString(), 6)]),
        from: wallet.address
      });
    } catch (simErr) {
      log("❌ Simulation failed: " + simErr.message);
      return;
    }

    // Pre-profit check
    const token = { address: tokenAddr, decimals: await getTokenDecimals(tokenAddr) };
    const buyOut = await getAmountOut(buyRouter, token, amount);
    const sellOut = await getAmountOut(sellRouter, token, amount);
    const expectedProfit = sellOut - buyOut;
    if (expectedProfit <= 0.000001) {
      log(`❌ Pre-profit too low (${expectedProfit.toFixed(6)} USDC), skipping`);
      return;
    }

    // Execute live tx if not dry run
    if (!CONFIG.DRY_RUN) {
      const tx = await arbContract.executeArbitrage(path, routers, ethers.parseUnits(amount.toString(), 6));
      const receipt = await tx.wait();
      if (!receipt || receipt.status === 0) {
        log("❌ Transaction failed or reverted");
        return;
      }
      log(`✅ Trade executed: txHash ${receipt.transactionHash}`);
    } else {
      log(`🟢 Dry run — simulated trade`);
    }

    // Read vault after
    const after = await getVaultBalanceUSDC();
    const net = after - before;
    if (net <= 0) {
      log("❌ Vault did not increase — trade ignored");
      return;
    }
    cumulativeProfit += net;
    log(`💰 Net Profit: ${net.toFixed(6)} USDC | Cumulative: ${cumulativeProfit.toFixed(6)} USDC`);
  } catch (err) {
    log("⚠ Trade execution error: " + (err.message || err));
  }
}

// -------------------------- SCAN --------------------------
async function scan() {
  log("🔍 Scanning for arbitrage opportunities...");
  for (const tp of CONFIG.TOKEN_PAIRS) {
    for (const buy of CONFIG.DEXES) {
      for (const sell of CONFIG.DEXES) {
        if (buy.router === sell.router) continue;
        try {
          const token = { address: tp.base, decimals: await getTokenDecimals(tp.base) };
          const buyOut = await getAmountOut(buy.router, token, 1);
          const sellOut = await getAmountOut(sell.router, token, 1);
          const profit = sellOut - buyOut;
          if (profit <= 0) continue;
          await executeTrade(buy.router, sell.router, tp.base, 1);
        } catch (err) {
          log(`⚠ Price fetch error ${buy.name}->${sell.name}: ${err.message}`);
        }
      }
    }
  }
}

// -------------------------- MAIN LOOP --------------------------
(async function main() {
  log("🚀 Live ARBJS bot started");
  while (true) {
    await scan();
    await sleep(CONFIG.SCAN_INTERVAL_MS);
  }
})();
