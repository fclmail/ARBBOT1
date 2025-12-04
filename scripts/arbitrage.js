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
const TRADE_AMOUNT_USDC = 0.05; // 0.05 USDC per arbitrage opportunity
const PROFIT_PCT_THRESHOLD = 0.002; // 0.2% minimum profit (0.002 as fraction)
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

// Logging helper
function logLine(msg){
  const t = new Date().toISOString();
  const line = `[${t}] ${msg}`;
  console.log(line);
  // Append to a log file if desired
  try {
    fs.appendFileSync("arb.log", line + "\n");
  } catch(e){
    // ignore
  }
}

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

// Entry point: main loop
async function mainLoop(){
  // Example: scan for a known token to arbitrage against USDC
  // We'll attempt arbitrage on each token we defined (WETH, WBTC, CRV)
  const tokenList = [tokens.WETH, tokens.WBTC, tokens.CRV];

  while (true){
    try {
      for (const tokenObj of tokenList){
        // We can try combinations: buy with USDC on buyRouter, sell back to USDC on sellRouter
        // Choose routers (could be dynamic; here we iterate over pairs)
        for (const [buyName, buyAddr] of Object.entries(routers)){
          for (const [sellName, sellAddr] of Object.entries(routers)){
            if (buyAddr.toLowerCase() === sellAddr.toLowerCase()) continue;

            // Compute min return USDC for amount TRADE_AMOUNT_USDC
            const minReturnUSDCbn = await computeMinReturnUSDC(
              buyAddr, sellAddr, tokenObj, TRADE_AMOUNT_USDC
            );
            // Convert to a number with decimals for comparison
            // minReturnUSDCbn is in USDC with 6 decimals
            const minReturnUSDC = Number(minReturnUSDCbn) / 1e6;

            // Calculate profit as (minReturnUSDC - TRADE_AMOUNT_USDC) / TRADE_AMOUNT_USDC
            // We want raw profit in USDC terms
            const rawProfitUSDC = minReturnUSDC - TRADE_AMOUNT_USDC;
            const profitPct = rawProfitUSDC / TRADE_AMOUNT_USDC;

            // Log detail
            logLine(`Scan: Buy on ${buyName}, Sell on ${sellName}, Token=${tokenObj.address}, TradeAmountUSDC=${TRADE_AMOUNT_USDC}, MinReturnUSDC=${minReturnUSDC.toFixed(6)}, ProfitUSDC=${rawProfitUSDC.toFixed(6)}, ProfitPct=${(profitPct*100).toFixed(4)}%`);

            // Check threshold: 0.2% profit threshold
            const requiredProfitUSDC = TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD;
            if (rawProfitUSDC >= requiredProfitUSDC){
              // Execute arbitrage via Vault
              logLine(`Arb viable. Executing: buy ${buyName}, sell ${sellName}, token ${tokenObj.address}, amountUSDC=${TRADE_AMOUNT_USDC}, minReturnUSDC=${minReturnUSDC.toFixed(6)}`);
              if (DRY_RUN){
                logLine(`DRY RUN: would call vault.executeArbitrage(...) with minReturnUSDC=${minReturnUSDC.toFixed(6)}`);
              } else {
                try {
                  const tx = await vaultContract.executeArbitrage(
                    buyAddr,
                    sellAddr,
                    tokenObj.address,
                    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6),
                    ethers.parseUnits(minReturnUSDC.toFixed(6).toString(), 6)
                  );
                  logLine(`TX sent: ${tx.hash}`);
                  const receipt = await tx.wait();
                  logLine(`TX mined in block ${receipt.blockNumber}, status ${receipt.status}`);
                } catch (e) {
                  logLine(`Arb execute failed: ${e.message || e}`);
                }
              }
            } else {
              // Not profitable enough; skip
              logLine(`Arb skipped: profit ${ (rawProfitUSDC).toFixed(6) } USDC (< threshold ${ requiredProfitUSDC.toFixed(6) } USDC)`);
            }

            // Small delay between checks to avoid spamming
            await new Promise(r => setTimeout(r, 50));
          }
        }
      }

    } catch (err) {
      logLine(`Error in mainLoop: ${err?.message ?? err}`);
    }

    // Wait before next scan iteration
    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

// Start
mainLoop().catch(err => {
  logLine(`Fatal error: ${err?.message ?? err}`);
});
