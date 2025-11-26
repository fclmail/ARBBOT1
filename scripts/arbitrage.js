// improved-arb-final.js
import { ethers, Wallet } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = false; // LIVE
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

// Deployed vault contract
const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x7DadE334120e659eDE4999c8813c183648b1bd19";

// Safety & trading defaults
const TRADE_AMOUNT_USDC = ethers.parseUnits("0.05", 6);         // 0.05 USDC (BigNumber, 6 decimals)
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.5); // percent over buy price
const GAS_EST_USDC = ethers.parseUnits(String(process.env.GAS_EST_USDC || "0.005"), 6); // conservative gas floor (BN)
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.3);     // percent
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30_000); // 30s loop

// Routers & tokens (whitelist)
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
};

const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 }
};

// CSV logging
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amountUSDC, profitUSDC, txHash }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amountUSDC, profitUSDC, txHash || ""].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC","TxHash"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ABI (executeArbitrage with minReturn) ----------
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
      { "internalType": "uint256", "name": "minReturnUSDC", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider) : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ERC20 helper ABI
const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

// Router ABI
const routerAbi = ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"];

// ---------- HELPERS ----------
function fmt(n, dec=6){ return Number(n).toFixed(dec); }

async function vaultUSDCAddress() {
  return await arbContract.USDC();
}

async function vaultUSDCBalanceBN() {
  const usdcAddr = await vaultUSDCAddress();
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
  return await usdc.balanceOf(CONTRACT_ADDRESS); // BigNumber (6 decimals)
}

// getAmountsOut, with fallback path via WBTC if direct fails
async function getAmountsOutSafe(routerAddr, path, amountInUnits) {
  const router = new ethers.Contract(routerAddr, routerAbi, provider);
  try {
    return await router.getAmountsOut(amountInUnits, path);
  } catch (err) {
    // if path has length 2 and fails, try via WBTC as a hop (only if path[0] != path[1])
    if (path.length === 2 && path[0] !== path[1]) {
      const fallback = [path[0], tokens.WBTC.address, path[path.length-1]];
      return await router.getAmountsOut(amountInUnits, fallback);
    }
    throw err;
  }
}

// compute conservative minReturnBN in USDC (6 decimals) using BigNumbers
async function computeMinReturnBN(buyRouter, sellRouter, tokenObj, amountUSDC_BN) {
  const usdcAddr = await vaultUSDCAddress();

  // 1) buy path: USDC -> token
  let buyAmounts = await getAmountsOutSafe(buyRouter, [usdcAddr, tokenObj.address], amountUSDC_BN);
  const tokenAmountBn = buyAmounts[buyAmounts.length - 1];
  if (!tokenAmountBn || tokenAmountBn.isZero()) return ethers.parseUnits("0", 6);

  // 2) sell path: token -> USDC
  let sellAmounts = await getAmountsOutSafe(sellRouter, [tokenObj.address, usdcAddr], tokenAmountBn);
  const expectedUSDCAfterBn = sellAmounts[sellAmounts.length - 1];

  // apply safety multiplier using integer math
  const slippagePct = SLIPPAGE_PCT; // e.g. 0.3
  const extraBuffer = 0.0025; // 0.25% extra
  const multFloat = Math.max(0, 1 - (slippagePct / 100) - extraBuffer);
  const BASE = ethers.BigNumber.from(1_000_000);
  const multiplierBn = ethers.BigNumber.from(Math.floor(multFloat * 1_000_000));

  const minReturnBn = expectedUSDCAfterBn.mul(multiplierBn).div(BASE);
  return minReturnBn; // BigNumber (6 decimals)
}

// estimate profit BN = minReturnBN - amountUSDC_BN (or zero)
async function estimateProfitBN(buyRouter, sellRouter, tokenObj, amountUSDC_BN) {
  try {
    const minReturnBn = await computeMinReturnBN(buyRouter, sellRouter, tokenObj, amountUSDC_BN);
    if (minReturnBn.lte(amountUSDC_BN)) return ethers.BigNumber.from(0);
    return minReturnBn.sub(amountUSDC_BN);
  } catch (e) {
    return ethers.BigNumber.from(0);
  }
}

// log buy/sell prices (USDC per token) for summary
async function getPriceNumbers(buyRouter, sellRouter, tokenObj, amountUSDC_BN) {
  const usdcAddr = await vaultUSDCAddress();
  try {
    const buyAmounts = await getAmountsOutSafe(buyRouter, [usdcAddr, tokenObj.address], amountUSDC_BN);
    const tokenOutBn = buyAmounts[buyAmounts.length - 1];
    const sellAmounts = await getAmountsOutSafe(sellRouter, [tokenObj.address, usdcAddr], tokenOutBn);
    const usdcOutBn = sellAmounts[sellAmounts.length - 1];

    const tokenOut = Number(ethers.formatUnits(tokenOutBn, tokenObj.decimals));
    const usdcIn = Number(ethers.formatUnits(amountUSDC_BN, 6));
    const usdcOut = Number(ethers.formatUnits(usdcOutBn, 6));
    const buyPrice = tokenOut > 0 ? usdcIn / tokenOut : Infinity;
    const sellPrice = tokenOut > 0 ? usdcOut / tokenOut : Infinity;
    return { buyPrice, sellPrice, tokenOut, usdcOut };
  } catch (e) {
    return { buyPrice: NaN, sellPrice: NaN, tokenOut: 0, usdcOut: 0 };
  }
}

// simulate and send tx safely
async function simulateAndSend(buyRouter, sellRouter, tokenObj, amountUSDC_BN, minReturnBn) {
  // encode call data
  const iface = arbContract.interface;
  const data = iface.encodeFunctionData("executeArbitrage", [buyRouter, sellRouter, tokenObj.address, amountUSDC_BN, minReturnBn]);

  // provider.call simulation
  try {
    await provider.call({ to: CONTRACT_ADDRESS, data, from: wallet.address });
  } catch (simErr) {
    console.warn("❌ Simulation failed (call would revert/panic):", (simErr && simErr.message) ? simErr.message.split("\n")[0] : simErr);
    return null;
  }

  // estimate gas
  let gasLimit;
  try {
    const gasEst = await provider.estimateGas({ to: CONTRACT_ADDRESS, data, from: wallet.address });
    gasLimit = gasEst.mul(120).div(100);
  } catch (gErr) {
    console.warn("❌ estimateGas failed:", (gErr && gErr.message) ? gErr.message.split("\n")[0] : gErr);
    return null;
  }

  // send tx
  try {
    const tx = await wallet.sendTransaction({ to: CONTRACT_ADDRESS, data, gasLimit });
    console.log("📡 TX SENT:", tx.hash);
    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) {
      console.log("✅ TX CONFIRMED:", receipt.transactionHash);
      return receipt;
    } else {
      console.log("❌ TX FAILED or REVERTED:", tx.hash);
      return receipt;
    }
  } catch (sendErr) {
    console.warn("❌ sendTransaction failed:", (sendErr && sendErr.message) ? sendErr.message.split("\n")[0] : sendErr);
    return null;
  }
}

// ---------- CORE: single-scan attempt ----------
let cumulativeProfitBN = ethers.BigNumber.from(0);

async function scanOnce() {
  console.log("\n🔍 Scanning for arbitrage opportunities...");

  // get vault USDC balance
  let vaultBalBN;
  try {
    vaultBalBN = await vaultUSDCBalanceBN();
  } catch (e) {
    console.warn("⚠️ Could not read vault USDC balance:", e.message || e);
    return;
  }
  const vaultBalFloat = Number(ethers.formatUnits(vaultBalBN, 6));
  console.log(`🏦 Vault Balance: ${fmt(vaultBalFloat, 6)} USDC`);

  for (const [symbol, tokenObj] of Object.entries(tokens)) {
    // skip if token is USDC itself
    const usdcAddr = (await vaultUSDCAddress()).toLowerCase();
    if (tokenObj.address.toLowerCase() === usdcAddr) continue;

    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyRouter === sellRouter) continue; // avoid identical routers

        try {
          // ensure vault has funds for the trade
          if (vaultBalBN.lt(TRADE_AMOUNT_USDC)) {
            console.log(`⚠️ Skipping trade — vault has insufficient USDC (${ethers.formatUnits(vaultBalBN,6)} < ${ethers.formatUnits(TRADE_AMOUNT_USDC,6)})`);
            continue;
          }

          // compute numerics for logs
          const priceInfo = await getPriceNumbers(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC);
          const buyPriceStr = isFinite(priceInfo.buyPrice) ? fmt(priceInfo.buyPrice,6) : "n/a";
          const sellPriceStr = isFinite(priceInfo.sellPrice) ? fmt(priceInfo.sellPrice,6) : "n/a";

          // estimate profit in BN
          const profitBN = await estimateProfitBN(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC);
          const profitFloat = Number(ethers.formatUnits(profitBN, 6));

          console.log(`💹 ${symbol} ${buyName}->${sellName} | buy=${buyPriceStr} sell=${sellPriceStr} | estProfit=${fmt(profitFloat,6)} USDC`);

          // quick % check (optional)
          let profitPct = 0;
          if (isFinite(priceInfo.buyPrice) && priceInfo.buyPrice > 0) {
            profitPct = (profitFloat / priceInfo.buyPrice) * 100;
          }

          // apply filters: must beat both MIN_PROFIT_PCT and GAS_EST_USDC
          const minProfitPctOk = profitPct >= MIN_PROFIT_PCT;
          const profitBeatsGas = profitBN.gt(GAS_EST_USDC);

          if (!minProfitPctOk || !profitBeatsGas) {
            // skip quietly
            // console.log(`| skipped (pct/gas) pctOk=${minProfitPctOk} gasOk=${profitBeatsGas}`);
            continue;
          }

          // compute conservative on-chain minReturnBN
          const minReturnBn = await computeMinReturnBN(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC);
          if (minReturnBn.lte(TRADE_AMOUNT_USDC)) {
            console.log("⚠️ computed minReturn ≤ amountIn — skipping");
            continue;
          }

          console.log(`🚨 PROFITABLE: ${symbol} ${buyName}->${sellName} | estProfit ${ethers.formatUnits(profitBN,6)} USDC | minReturn ${ethers.formatUnits(minReturnBn,6)} USDC`);
          if (DRY_RUN) {
            console.log("🧪 DRY_RUN: would simulate/execute here (stopping)");
            continue;
          }

          // simulate & send
          const receipt = await simulateAndSend(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC, minReturnBn);
          if (!receipt) {
            console.log("⚠️ Execution aborted or failed during simulation/send");
            continue;
          }

          // if tx succeeded, compute new vault balance and profit
          const afterBN = await vaultUSDCBalanceBN();
          const afterFloat = Number(ethers.formatUnits(afterBN,6));
          const beforeFloat = Number(ethers.formatUnits(vaultBalBN,6));
          const realProfitFloat = afterFloat - beforeFloat;
          const realProfitBN = ethers.parseUnits(String(realProfitFloat.toFixed(6)), 6);

          if (afterBN.lte(vaultBalBN)) {
            console.log("❌ After-trade vault did not increase — treating as failed");
            continue;
          }

          cumulativeProfitBN = cumulativeProfitBN.add(realProfitBN);
          console.log(`💰 REAL Net Profit This Trade: ${realProfitFloat.toFixed(6)} USDC`);
          console.log(`📊 Cumulative Profit (USDC): ${ethers.formatUnits(cumulativeProfitBN,6)}`);

          // log to CSV (store tx hash & details)
          logTradeCSV({
            timestamp: new Date().toISOString(),
            symbol,
            buyRouter,
            sellRouter,
            amountUSDC: ethers.formatUnits(TRADE_AMOUNT_USDC,6),
            profitUSDC: realProfitFloat.toFixed(6),
            txHash: receipt.transactionHash
          });

        } catch (err) {
          // catch router call errors (IDENTICAL_ADDRESSES, Panic) or other problems
          const msg = err && err.message ? err.message : String(err);
          console.warn("⚠️ Scan inner error:", msg.split("\n")[0]);
        }
      }
    }
  }

  // persist CSV at end of scan
  saveCSV();
}

// ---------- MAIN LOOP ----------
(async function main(){
  try {
    const usdcAddr = await arbContract.USDC();
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
    console.log("💱 USDC token address:", usdcAddr);
    console.log("🚀 Arbitrage bot started (LIVE)");
  } catch (e) {
    console.error("Fatal init error:", e.message || e);
    process.exit(1);
  }

  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.error("Fatal scan error:", e.message || e);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
})();
