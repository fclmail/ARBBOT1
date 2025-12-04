import { ethers, Wallet, getAddress } from "ethers";
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
const TRADE_AMOUNT_USDC = 10.05; // USDC per arbitrage
const PROFIT_PCT_THRESHOLD = 0.002; // 0.2%
const SLIPPAGE_PCT = 0.2; // 0.2% slippage
const LOOP_DELAY_MS = 5000; // 5s loop

// Provider & wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Tokens (ensure correct checksum)
const tokens = {
  WETH: { address: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"), decimals: 18 },
  WBTC: { address: getAddress("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"), decimals: 8 },
  CRV:  { address: getAddress("0x172370d5Cd63279fFa6d502Dab29171933a610Af"), decimals: 18 }
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

// -------------------------
// Helpers
// -------------------------
function fmt(n, dec = 6){ return Number(n).toFixed(dec); }

function colorText(msg, type) {
  switch(type) {
    case 'profit': return `\x1b[32m${msg}\x1b[0m`; // green
    case 'loss': return `\x1b[31m${msg}\x1b[0m`;   // red
    case 'info': return `\x1b[36m${msg}\x1b[0m`;   // cyan
    default: return msg;
  }
}

function logLine(msg, type='info') {
  const t = new Date().toISOString();
  const line = `[${t}] ${msg}`;
  console.log(colorText(line, type));
  try { fs.appendFileSync("arb.log", line + "\n"); } catch(e){}
}

// Get USDC balance
async function getVaultUSDCBalanceBN() {
  const usdcAddr = await vaultContract.USDC();
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
  return await usdc.balanceOf(VAULT_ADDRESS);
}

// Safe amounts out
async function safeGetAmountsOut(routerAddr, path, amountInUnits) {
  if (path.length >= 2 && path[0].toLowerCase() === path[path.length - 1].toLowerCase()) {
    return [amountInUnits, amountInUnits];
  }
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  return await router.getAmountsOut(amountInUnits, path);
}

// Compute expected USDC return after buy/sell
async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDCFloat) {
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

// -------------------------
// Main loop
// -------------------------
async function mainLoop() {
  const tokenList = [tokens.WETH, tokens.WBTC, tokens.CRV];

  while(true){
    try{
      for(const tokenObj of tokenList){
        const routerEntries = Object.entries(routers);
        for(const [buyName, buyAddr] of routerEntries){
          for(const [sellName, sellAddr] of routerEntries){
            if(buyAddr.toLowerCase() === sellAddr.toLowerCase()) continue;

            const minReturnUSDCbn = await computeMinReturnUSDC(buyAddr, sellAddr, tokenObj, TRADE_AMOUNT_USDC);
            const minReturnUSDC = Number(minReturnUSDCbn)/1e6;

            // Compute buy/sell prices per token
            const buyPrice = TRADE_AMOUNT_USDC / minReturnUSDC; // rough approximation
            const sellPrice = minReturnUSDC / TRADE_AMOUNT_USDC;

            // Profit calculations
            const rawProfitUSDC = minReturnUSDC - TRADE_AMOUNT_USDC;
            const profitPct = rawProfitUSDC / TRADE_AMOUNT_USDC;

            // Logging
            const profitText = rawProfitUSDC >= TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD 
              ? colorText("PROFIT", "profit") 
              : colorText("SKIP", "loss");

            logLine(`Scan: Token=${tokenObj.address} | Buy=${buyName} | Sell=${sellName} | BuyPrice=${fmt(buyPrice)} | SellPrice=${fmt(sellPrice)} | Profit=${fmt(rawProfitUSDC)} USDC (${(profitPct*100).toFixed(2)}%) | ${profitText}`, 
              rawProfitUSDC >= TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD ? 'profit' : 'loss');

            // Execute if profitable
            if(rawProfitUSDC >= TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD){
              logLine(`🚨 Executing arbitrage: Buy ${buyName}, Sell ${sellName}, Token ${tokenObj.address}`, 'profit');
              if(DRY_RUN){
                logLine(`DRY RUN: would execute vault.executeArbitrage(...)`, 'info');
              } else {
                try{
                  const tx = await vaultContract.executeArbitrage(
                    buyAddr,
                    sellAddr,
                    tokenObj.address,
                    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6),
                    ethers.parseUnits(minReturnUSDC.toFixed(6).toString(), 6)
                  );
                  logLine(`TX sent: ${tx.hash}`, 'info');
                  const receipt = await tx.wait();
                  logLine(`✅ TX mined: block ${receipt.blockNumber}, status ${receipt.status}`, 'profit');
                } catch(e){
                  logLine(`⚠️ Execution failed: ${e?.message ?? e}`, 'loss');
                }
              }
            }

            await new Promise(r=>setTimeout(r,50));
          }
        }
      }
    } catch(err){
      logLine(`⚠️ Loop error: ${err?.message ?? err}`, 'loss');
    }

    await new Promise(r=>setTimeout(r, LOOP_DELAY_MS));
  }
}

// Start
mainLoop().catch(err => {
  logLine(`Fatal error: ${err?.message ?? err}`, 'loss');
});
