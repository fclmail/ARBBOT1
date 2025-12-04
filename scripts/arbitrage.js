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
const TRADE_AMOUNT_USDC = 0.05; // 0.05 USDC per arbitrage
const PROFIT_PCT_THRESHOLD = 0.002; // 0.2% minimum profit (0.002 as fraction)
const SLIPPAGE_PCT = 1; // 0.2% slippage (adjustable)
const LOOP_DELAY_MS = 5000; // 5s loop

// Vault balance hint (for decision context). If you want to fetch live balance, implement here.
const VAULT_BALANCE_USDC_E_HINT = 0.12; // example: "0.12 USDC.e" as per your log
// If you want to cap dynamic, you can fetch via USDC balance:
// async function fetchVaultUSDCBalance() {
//   const usdcAddr = await vaultContract.USDC();
//   const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
//   const bal = await usdc.balanceOf(VAULT_ADDRESS);
//   // convert to USDC units (assuming 6 decimals for USDC)
//   return Number(bal) / 1e6;
// }

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
  CRV:  { address: "0x172370d5Cd63279fFa6d502Dab29171933a610Af", decimals: 18 }
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
  // Append to a log file
  try {
    fs.appendFileSync("arb.log", line + "\n");
  } catch(e){
    // ignore
  }
}





// Core helpers

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





// Main loop and execution logic

async function mainLoop(){
  // Define tokens to check; adjust as needed
  const tokenList = [tokens.WETH, tokens.WBTC, tokens.CRV];

  while (true){
    try {
      for (const tokenObj of tokenList){
        // Consider all ordered router pairs (buy on A, sell on B)
        const routerEntries = Object.entries(routers);
        for (const [buyName, buyAddr] of routerEntries){
          for (const [sellName, sellAddr] of routerEntries){
            if (buyAddr.toLowerCase() === sellAddr.toLowerCase()) continue;

            // Compute min return USDC for our trade amount
            const minReturnUSDCbn = await computeMinReturnUSDC(
              buyAddr, sellAddr, tokenObj, TRADE_AMOUNT_USDC
            );
            const minReturnUSDC = Number(minReturnUSDCbn) / 1e6;

            // Profit calculations
            const rawProfitUSDC = minReturnUSDC - TRADE_AMOUNT_USDC;
            const profitPct = rawProfitUSDC / TRADE_AMOUNT_USDC;

            // Logging
            logLine(`Scan: Buy ${buyName}, Sell ${sellName}, Token=${tokenObj.address}, TradeAmountUSDC=${TRADE_AMOUNT_USDC}, MinReturnUSDC=${minReturnUSDC.toFixed(6)}, ProfitUSDC=${rawProfitUSDC.toFixed(6)}, ProfitPct=${(profitPct*100).toFixed(4)}%`);

            // Profit gate: require at least PROFIT_PCT_THRESHOLD
            const requiredProfitUSDC = TRADE_AMOUNT_USDC * PROFIT_PCT_THRESHOLD;

            if (rawProfitUSDC >= requiredProfitUSDC){
              // Execute arbitrage
              logLine(`Arb viable. Executing: buy ${buyName}, sell ${sellName}, token ${tokenObj.address}, amountUSDC=${TRADE_AMOUNT_USDC}, minReturnUSDC=${minReturnUSDC.toFixed(6)}`);
              if (DRY_RUN){
                logLine(`DRY RUN: would call vault.executeArbitrage(...) with minReturnUSDC=${minReturnUSDC.toFixed(6)}`);
              } else {
                try {
                  // Ensure minReturnUSDC is expressed with 6 decimals
                  const tx = await vaultContract.executeArbitrage(
                    buyAddr,
                    sellAddr,
                    tokenObj.address,
                    ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6),
                    ethers.parseUnits(minReturnUSDC.toFixed(6).toString(), 6)
                  );
                  logLine(`TX sent: ${tx.hash}`);
                  const receipt = await tx.wait();
                  logLine(`TX mined: block ${receipt.blockNumber}, status ${receipt.status}`);
                } catch (e) {
                  logLine(`Arb execution failed: ${e?.message ?? e}`);
                }
              }

            } else {
              // Not profitable enough; skip
              logLine(`Arb skipped: profit ${rawProfitUSDC.toFixed(6)} USDC (< required ${requiredProfitUSDC.toFixed(6)} USDC)`);
            }

            // Small delay to avoid excessive rapid fire between pairs
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






// Extra notes and optional enhancements (not required for core arb.js)

// Optional vault balance gating (uncomment to enable dynamic checks)
// You can add a balance check at the top of the inner loop to skip trades when vault balance is too low.
// async function vaultHasSufficientBalance(requiredUSDC) {
//   const balBN = await getVaultUSDCBalanceBN();
//   // balBN is in the token's smallest unit; convert to USDC with 6 decimals
//   const balUSDC = Number(balBN) / 1e6;
//   return balUSDC >= requiredUSDC;
// }

// Example: tiny helper to format numbers consistently for logs
function nf(n, d=6){ return Number(n).toFixed(d); }

// End of script
