// improved-arb-fixed.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false; // LIVE mode per your instruction
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// Hardcoded vault contract address (yours)
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Trade settings (as requested)
const TRADE_AMOUNT_USDC = 0.08; // 0.05 USDC
const MIN_EXPECTED_PROFIT_USDC = 0.00005; // tiny floor, still conservative
const SLIPPAGE_PCT = 0.3; // slippage allowance %
const LOOP_DELAY_MS = 5000; // 5 seconds loop

// Provider & wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

// Token whitelist
const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 }
};

// Vault ABI (executeArbitrage with minReturnUSDC)
const vaultAbi = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];
const vaultContract = DRY_RUN
  ? new ethers.Contract(VAULT_ADDRESS, vaultAbi, provider)
  : new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// Minimal ERC20 / router ABIs
const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const routerAbi = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)"];

// CSV logging (unchanged)
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (!csvRows.length) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- HELPERS ----------
function fmt(n, dec=6){ return Number(n).toFixed(dec); }

// get vault USDC balance as bigint (6 decimals)
async function getVaultUSDCBalanceBN(){
  const usdcAddr = await vaultContract.USDC();
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
  return await usdc.balanceOf(VAULT_ADDRESS); // bigint
}

// safe wrapper for getAmountsOut that avoids IDENTICAL_ADDRESSES and returns an array of bigints
async function safeGetAmountsOut(routerAddr, path, amountInUnits){
  // if path start==end -> router library will revert; treat as no-op: return [amountInUnits, amountInUnits]
  if (path.length >= 2 && path[0].toLowerCase() === path[path.length - 1].toLowerCase()) {
    // return an array where last element equals amountInUnits (no change)
    return [amountInUnits, amountInUnits];
  }
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  return await router.getAmountsOut(amountInUnits, path); // should be bigint[] in ethers v6
}

// compute conservative minReturnUSDC (bigint, 6 decimals)
async function computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDCFloat){
  const usdcAddr = await vaultContract.USDC();
  const amountInUnits = ethers.parseUnits(amountUSDCFloat.toString(), 6); // bigint

  // Attempt direct path USDC->token, fallback via WBTC if needed
  let buyAmounts;
  try {
    buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokenObj.address], amountInUnits);
  } catch (e) {
    // fallback via WBTC (if token has pool via WBTC)
    buyAmounts = await safeGetAmountsOut(buyRouter, [usdcAddr, tokens.WBTC.address, tokenObj.address], amountInUnits);
  }
  const tokenAmountBn = buyAmounts[buyAmounts.length - 1];

  // If tokenAmountBn is zero or undefined, return zero
  if (!tokenAmountBn || tokenAmountBn === 0n) return 0n;

  // Sell path token->USDC to get expected USDC out
  let sellAmounts;
  try {
    sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, usdcAddr], tokenAmountBn);
  } catch (e) {
    sellAmounts = await safeGetAmountsOut(sellRouter, [tokenObj.address, tokens.WBTC.address, usdcAddr], tokenAmountBn);
  }
  const expectedUSDCOutBn = sellAmounts[sellAmounts.length - 1]; // bigint

  // apply conservative safety multiplier: (1 - SLIPPAGE_PCT/100 - 0.0025)
  const multFloat = Math.max(0, 1 - (SLIPPAGE_PCT / 100) - 0.0025);
  // Using integer math with 1e6 base
  const BASE = 1_000_000n;
  const multiplierInt = BigInt(Math.floor(multFloat * Number(BASE)));
  const computedMinReturnBn = (expectedUSDCOutBn * multiplierInt) / BASE;

  return computedMinReturnBn; // bigint (6 decimals)
}

// ---------- TRADE EXECUTION ----------
async function executeTradeIfProfitable(buyRouter, sellRouter, tokenObj, amountUSDCFloat){
  // Quick guard: avoid identical router addresses
  if (buyRouter.toLowerCase() === sellRouter.toLowerCase()) return;

  // vault before (bigint)
  const beforeBn = await getVaultUSDCBalanceBN();

  // compute required minReturnBN (bigint)
  let minReturnBn;
  try {
    minReturnBn = await computeMinReturnUSDC(buyRouter, sellRouter, tokenObj, amountUSDCFloat);
  } catch (e) {
    console.warn("⚠️ computeMinReturn failed:", e.message || e);
    return;
  }

  const amountInBn = ethers.parseUnits(amountUSDCFloat.toString(), 6); // bigint

  // ensure computed min return is greater than amountIn (profit > 0)
  if (minReturnBn <= amountInBn) {
    // Not profitable after safety multiplier
    // Small helpful log showing values for debug
    console.log(`💤 Not profitable (minReturn ≤ amountIn): minReturn=${ethers.formatUnits(minReturnBn,6)} amountIn=${ethers.formatUnits(amountInBn,6)}`);
    return;
  }

  // enforce a tiny expected profit threshold (avoid dust)
  const profitBn = minReturnBn - amountInBn;
  const profitFloat = Number(ethers.formatUnits(profitBn, 6));
  if (profitFloat < MIN_EXPECTED_PROFIT_USDC) {
    console.log(`💤 Profit ${profitFloat.toFixed(6)} USDC < MIN_EXPECTED_PROFIT_USDC ${MIN_EXPECTED_PROFIT_USDC} — skipping`);
    return;
  }

  // DRY_RUN guard
  if (DRY_RUN) {
    console.log(`🧪 DRY_RUN: would execute arbitrage buy->sell on ${tokenObj.address} amount ${amountUSDCFloat} minReturn ${ethers.formatUnits(minReturnBn,6)}`);
    return;
  }

  // Build calldata & simulate via provider.call (to detect on-chain reverts)
  const iface = new ethers.Interface(vaultAbi);
  const data = iface.encodeFunctionData("executeArbitrage", [buyRouter, sellRouter, tokenObj.address, amountInBn, minReturnBn]);

  try {
    // call simulation to detect revert w/o spending gas
    await provider.call({ to: VAULT_ADDRESS, data, from: wallet.address });
  } catch (simErr) {
    console.warn("❌ Simulation failed — contract would revert. Err:", (simErr && simErr.message) ? simErr.message.split("\n")[0] : simErr);
    return;
  }

  // estimate gas and send tx (with a buffer)
  try {
    const gasEstimate = await provider.estimateGas({ to: VAULT_ADDRESS, data, from: wallet.address });
    const gasLimit = gasEstimate * 120n / 100n; // 20% buffer
    const tx = await wallet.sendTransaction({ to: VAULT_ADDRESS, data, gasLimit });
    console.log("🚀 Tx sent:", tx.hash);
    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) {
      const afterBn = await getVaultUSDCBalanceBN();
      const realProfitBn = afterBn - beforeBn;
      console.log(`✅ Trade completed. Profit: ${fmt(Number(ethers.formatUnits(realProfitBn,6)))} USDC`);
      // csv log
      logTradeCSV({
        timestamp: new Date().toISOString(),
        symbol: Object.keys(tokens).find(k => tokens[k].address.toLowerCase() === tokenObj.address.toLowerCase()) || tokenObj.address,
        buyRouter,
        sellRouter,
        amount: amountUSDCFloat,
        profitUSDC: fmt(Number(ethers.formatUnits(realProfitBn,6)))
      });
    } else {
      console.log("❌ Transaction reverted or failed on-chain");
    }
  } catch (sendErr) {
    console.warn("❌ estimateGas/send failed:", sendErr && sendErr.message ? sendErr.message.split("\n")[0] : sendErr);
  }
}

// ---------- SCAN LOOP ----------
async function scanOnce(){
  try {
    const vaultBalBn = await getVaultUSDCBalanceBN();
    const vaultBalFloat = Number(ethers.formatUnits(vaultBalBn, 6));
    if (vaultBalFloat < TRADE_AMOUNT_USDC) {
      console.log(`⚠️ Vault balance too low: ${vaultBalFloat} USDC (need ${TRADE_AMOUNT_USDC})`);
      return;
    }

    // For each token / router pair
    for (const [symbol, tokenObj] of Object.entries(tokens)) {
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyRouter.toLowerCase() === sellRouter.toLowerCase()) continue;
          // avoid token === USDC (no point)
          if (tokenObj.address.toLowerCase() === (await vaultContract.USDC()).toLowerCase()) continue;

          // compute quickly and only attempt if computed minReturn > amountIn (profit)
          try {
            await executeTradeIfProfitable(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC);
          } catch (e) {
            console.warn("⚠️ Trade attempt error:", e && e.message ? e.message.split("\n")[0] : e);
          }
        }
      }
    }

    // persist CSV after each scan
    saveCSV();

  } catch (e) {
    console.warn("⚠️ scanOnce top-level error:", e && e.message ? e.message.split("\n")[0] : e);
  }
}

// ---------- MAIN ----------
(async () => {
  const owner = await vaultContract.owner();
  const usdcAddr = await vaultContract.USDC();
  console.log("🏛 Vault:", VAULT_ADDRESS);
  console.log("👤 Owner:", owner);
  console.log("💱 USDC:", usdcAddr);
  console.log("🚀 Arbitrage bot started (LIVE)");

  // loop forever every LOOP_DELAY_MS
  while (true) {
    await scanOnce();
    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
})();
