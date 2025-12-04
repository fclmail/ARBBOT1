import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false; // LIVE mode
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings
const TRADE_AMOUNT_USDC = 0.05; // 0.05 USDC
const PROFIT_PCT_THRESHOLD = 0.002; // 0.2% minimum profit
const SLIPPAGE_PCT = 0.1; // 0.1% slippage
const LOOP_DELAY_MS = 5000; // 5s loop

// Provider & wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Tokens (fixed checksum)
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  CRV:  { address: "0x172370d5Cd63279eFa6d502Dab29171933a610Af", decimals: 18 }
};

// Vault ABI
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];

const vaultContract = DRY_RUN
  ? new ethers.Contract(VAULT_ADDRESS, vaultAbi, provider)
  : new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

const erc20Abi = ["function balanceOf(address) view returns(uint256)"];
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[])"];

function fmt(n, dec=6){ return Number(n).toFixed(dec); }

async function getVaultUSDCBalanceBN(){
  const usdcAddr = await vaultContract.USDC();
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
  return await usdc.balanceOf(VAULT_ADDRESS);
}

async function safeGetAmountsOut(routerAddr, path, amountInUnits){
  if (path.length >= 2 && path[0].toLowerCase() === path[path.length - 1].toLowerCase()) {
    return [amountInUnits, amountInUnits];
  }
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  return await router.getAmountsOut(amountInUnits, path);
}

async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDCFloat){
  const usdcAddr = await vaultContract.USDC();
  const amountInUnits = ethers.parseUnits(amountUSDCFloat.toString(), 6);

  let buyAmounts;
  try {
    buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokenObj.address], amountInUnits);
  } catch {
    buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokens.WBTC.address, tokenObj.address], amountInUnits);
  }

  const tokenAmountBn = buyAmounts[buyAmounts.length - 1];
  if (!tokenAmountBn || tokenAmountBn === 0n) return 0n;

  let sellAmounts;
  try {
    sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, usdcAddr], tokenAmountBn);
  } catch {
    sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, tokens.WBTC.address, usdcAddr], tokenAmountBn);
  }

  const expectedUSDCOutBn = sellAmounts[sellAmounts.length - 1];
  const multFloat = 1 - SLIPPAGE_PCT / 100;
  const BASE = 1_000_000n;
  const multiplierInt = BigInt(Math.floor(multFloat * Number(BASE)));
  return (expectedUSDCOutBn * multiplierInt) / BASE;
}

async function executeTradeIfProfitable(buyRouter, sellRouter, tokenObj, amountUSDCFloat){
  if (buyRouter.toLowerCase() === sellRouter.toLowerCase()) return;

  const beforeBn = await getVaultUSDCBalanceBN();
  const minReturnBn = await computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDCFloat);
  const amountInBn = ethers.parseUnits(amountUSDCFloat.toString(), 6);

  // calculate required min return using 0.2% threshold
  const minProfitBn = (amountInBn * BigInt(Math.floor(PROFIT_PCT_THRESHOLD * 1e6))) / 1_000_000n;
  const requiredReturnBn = amountInBn + minProfitBn;

  if (minReturnBn < requiredReturnBn) {
    console.log(`💤 Not profitable: expected=${ethers.formatUnits(minReturnBn,6)} < required=${ethers.formatUnits(requiredReturnBn,6)}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`🧪 DRY_RUN: would execute arbitrage on ${tokenObj.address}`);
    return;
  }

  const iface = new ethers.Interface(vaultAbi);
  const data = iface.encodeFunctionData("executeArbitrage", [buyRouter, sellRouter, tokenObj.address, amountInBn, minReturnBn]);

  try {
    await provider.call({ to: VAULT_ADDRESS, data, from: wallet.address });
  } catch {
    console.warn("❌ Simulation failed, skipping trade");
    return;
  }

  try {
    const gasEstimate = await provider.estimateGas({ to: VAULT_ADDRESS, data, from: wallet.address });
    const gasLimit = gasEstimate * 120n / 100n;
    const tx = await wallet.sendTransaction({ to: VAULT_ADDRESS, data, gasLimit });
    console.log("🚀 Tx sent:", tx.hash);
    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) {
      const afterBn = await getVaultUSDCBalanceBN();
      const realProfitBn = afterBn - beforeBn;
      console.log(`✅ Trade completed. Profit: ${fmt(Number(ethers.formatUnits(realProfitBn,6)))} USDC`);
    } else {
      console.log("❌ Transaction failed");
    }
  } catch (e) {
    console.warn("❌ Transaction error:", e.message || e);
  }
}

async function scanOnce(){
  const vaultBalBn = await getVaultUSDCBalanceBN();
  const vaultBalFloat = Number(ethers.formatUnits(vaultBalBn, 6));
  if (vaultBalFloat < TRADE_AMOUNT_USDC) {
    console.log(`⚠️ Vault balance too low: ${vaultBalFloat} USDC (need ${TRADE_AMOUNT_USDC})`);
    return;
  }

  for (const tokenObj of Object.values(tokens)) {
    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {
        await executeTradeIfProfitable(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC);
      }
    }
  }
}

(async () => {
  const owner = await vaultContract.owner();
  const usdcAddr = await vaultContract.USDC();
  console.log("🏛 Vault:", VAULT_ADDRESS);
  console.log("👤 Owner:", owner);
  console.log("💱 USDC:", usdcAddr);
  console.log("🚀 Bot started (LIVE)");

  while (true) {
    await scanOnce();
    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
})();
