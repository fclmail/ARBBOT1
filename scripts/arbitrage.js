// scripts/arbitrage.js
// ─────────────────────────────────────────────
// 🔹 AAVE FLASH ARB BOT — Polygon (Full ABI + robust logging + callStatic + gas & net profit)
// ─────────────────────────────────────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Hardcoded contract
const SCAN_INTERVAL_MS = 40_000; // 40 seconds as requested
const TRADE_AMOUNT_USDC = 10; // default trade amount (human USDC)
const MIN_PROFIT_PCT = 3;     // threshold %
const SLIPPAGE_PCT = 0;       // slippage assumption %
const MIN_NET_PROFIT_USDC = 1; // only execute if net profit > $1 (you can change)

// sanity
if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── FULL CONTRACT ABI (from you) ───────────────
const arbAbi = [
  { "inputs":[{"internalType":"address","name":"buyRouter","type":"address"},{"internalType":"address","name":"sellRouter","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],"name":"executeArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function" },
  { "inputs":[{"internalType":"address","name":"asset","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"address","name":"","type":"address"},{"internalType":"bytes","name":"params","type":"bytes"}],"name":"executeOperation","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function" },
  { "inputs":[{"internalType":"uint256","name":"_minProfit","type":"uint256"}],"name":"setMinProfit","outputs":[],"stateMutability":"nonpayable","type":"function" },
  { "inputs":[],"name":"AAVE_POOL","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function" },
  { "inputs":[],"name":"minProfit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function" },
  { "inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function" },
  { "inputs":[],"name":"USDC","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── ROUTERS (normalize / skip invalid) ───────────────
const routerAddressesRaw = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routers = {};
for (const [k, v] of Object.entries(routerAddressesRaw)) {
  try {
    routers[k] = ethers.getAddress(v);
  } catch (err) {
    console.warn(`⚠️ Skipping invalid router address for ${k}: ${v}`);
  }
}

// ─────────────── TOKENS + WMATIC (for gas->USDC conversion) ───────────────
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:  { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
};

// WMATIC (wrapped MATIC) address on Polygon (used to price gas in USDC)
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // widely used wrapped MATIC

// QuickSwap router (used to price MATIC->USDC); if missing, we'll fallback to gas in MATIC only.
const QUICKSWAP_ROUTER = routers.QuickSwap || null;

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getUSDCAddress() {
  try {
    const addr = await arbContract.USDC();
    return ethers.getAddress(addr);
  } catch (e) {
    throw new Error("Failed to read USDC address from contract: " + (e.message || e));
  }
}

/**
 * getAmountOut(routerAddr, token, amountInHumanUSDC)
 * - returns how many `token` units you'd receive for `amountInHumanUSDC` (human USDC, e.g. 10)
 */
async function getAmountOut(routerAddr, token, amountInHumanUSDC) {
  if (!routerAddr) throw new Error("routerAddr missing");
  const usdcAddress = await getUSDCAddress();
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);

  const amountIn = ethers.parseUnits(amountInHumanUSDC.toString(), 6); // USDC decimals 6
  const pathDirect = [usdcAddress, token.address];

  try {
    const amounts = await router.getAmountsOut(amountIn, pathDirect);
    const last = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(last, token.decimals));
  } catch (_) {
    // fallback path via WMATIC
    const path2 = [usdcAddress, WMATIC, token.address];
    const amounts = await router.getAmountsOut(amountIn, path2);
    const last = amounts[amounts.length - 1];
    return Number(ethers.formatUnits(last, token.decimals));
  }
}

/**
 * estimateGasCostInMatic(txData)
 * - expects a populated tx object (to + data)
 * - returns { gasEstimate (BigInt), gasPrice (BigInt), gasCostMatic (number in MATIC) }
 */
async function estimateGasCostMatic(populatedTx) {
  // ensure 'to' set; populatedTx should come from populateTransaction
  if (!populatedTx.to) throw new Error("populateTransaction missing to");

  const gasEstimate = await wallet.estimateGas(populatedTx);
  // provider.getGasPrice() exists on Polygon (returns wei)
  const gasPrice = await provider.getGasPrice();
  const gasCostWei = gasEstimate * gasPrice;
  const gasCostMatic = Number(ethers.formatUnits(gasCostWei, 18)); // MATIC amount
  return { gasEstimate, gasPrice, gasCostMatic };
}

/**
 * convertMaticToUSDC( maticAmountNumber )
 * - uses QuickSwap router getAmountsOut(WMATIC -> USDC)
 * - returns approximate USDC value for MATIC amount
 */
async function convertMaticToUSDC(maticAmount) {
  if (!QUICKSWAP_ROUTER) return null;
  try {
    const router = new ethers.Contract(QUICKSWAP_ROUTER, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    const amountIn = ethers.parseUnits(maticAmount.toString(), 18);
    const usdcAddress = await getUSDCAddress();
    const path = [WMATIC, usdcAddress];
    const amounts = await router.getAmountsOut(amountIn, path);
    const usdc = ethers.formatUnits(amounts[amounts.length - 1], 6);
    return Number(usdc);
  } catch (e) {
    return null; // if any error, we'll only report gas in MATIC
  }
}

// Read contract USDC balance
async function getContractUSDCBalance() {
  const usdcAddr = await getUSDCAddress();
  const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = await usdc.balanceOf(CONTRACT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

// Read wallet MATIC balance
async function getWalletMaticBalance() {
  const bal = await provider.getBalance(wallet.address);
  return Number(ethers.formatUnits(bal, 18));
}

// ─────────────── EXECUTE TRADE (with callStatic + gas check + detailed logging) ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountHumanUSDC) {
  // amountHumanUSDC is e.g. 10
  try {
    const usdcBefore = await getContractUSDCBalance();
    const walletMaticBefore = await getWalletMaticBalance();

    const amountUnits = ethers.parseUnits(amountHumanUSDC.toString(), 6);

    // populate transaction (so we can estimate gas)
    const populated = await arbContract.populateTransaction.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, amountUnits
    );

    // attach 'to' (contract address) for estimateGas (populateTransaction includes to by default)
    populated.to = CONTRACT_ADDRESS;

    // estimate gas and gas cost in MATIC
    const { gasEstimate, gasPrice, gasCostMatic } = await estimateGasCostMatic(populated);

    // convert gas cost to USDC (approx) using QuickSwap path WMATIC->USDC
    const gasCostUSDCapprox = await convertMaticToUSDC(gasCostMatic);

    // callStatic simulation: prevents sending hopeless txs (this simulates the whole flash loan path)
    try {
      await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountUnits);
    } catch (simErr) {
      console.warn(`⚠️ callStatic simulation reverted — skipping execution. reason: ${simErr.reason || simErr.message || simErr}`);
      return { executed: false, reason: "callStatic reverted", simErr };
    }

    // optional net profit check: we compute gross profit in scan already, but we also ensure estimated net > MIN_NET_PROFIT_USDC
    // For safety, we require estimated gas in USDC < (estimated gross profit - MIN_NET_PROFIT_USDC)
    // We'll return gasCostUSDCapprox null if conversion failed; in that case we still try but mark as riskier.
    return { executed: true, gasEstimate, gasPrice, gasCostMatic, gasCostUSDCapprox, usdcBefore, walletMaticBefore, populated };
  } catch (err) {
    console.error(`⚠️ Trade simulation or gas estimate failed: ${err.reason || err.message || err}`);
    return { executed: false, reason: err.message || err };
  }
}

// send tx (separated so we simulate first then send)
async function sendTradeTx(populatedTx, amountHumanUSDC) {
  try {
    // send actual tx with a buffer on gasLimit
    const gasEstimate = await wallet.estimateGas(populatedTx);
    const gasLimit = gasEstimate * 2n;
    const tx = await wallet.sendTransaction({ to: CONTRACT_ADDRESS, data: populatedTx.data, gasLimit });
    console.log(`⏳ Trade tx sent: ${tx.hash} — waiting for confirmation...`);
    const receipt = await tx.wait();
    return receipt;
  } catch (err) {
    throw err;
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scanOnce(tradeAmountHuman = TRADE_AMOUNT_USDC) {
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];
  const usdcAddr = await getUSDCAddress();

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        if (!buyRouter || !sellRouter) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, tradeAmountHuman);
          const sellOut = await getAmountOut(sellRouter, token, tradeAmountHuman);

          // if buyOut or sellOut are zero or NaN, skip
          if (!buyOut || !sellOut || isNaN(buyOut) || isNaN(sellOut) || buyOut <= 0 || sellOut <= 0) {
            continue;
          }

          const buyPrice = tradeAmountHuman / buyOut;  // USDC per token on buy
          const sellPrice = tradeAmountHuman / sellOut; // USDC per token on sell

          let profitUSDC = sellPrice - buyPrice; // gross
          let profitPct = (profitUSDC / buyPrice) * 100;
          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

          // Only consider human-visible profit (not tiny dust)
          if (profitPct >= MIN_PROFIT_PCT && profitUSDC > 0) {
            // Detailed log before attempting
            console.log(`\n🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Estimated gross profit: ${fmt(profitUSDC,6)} USDC (${fmt(profitPct,2)}%)`);
            console.log(`🔹 Opportunity: Buy on ${buyRouter} / Sell on ${sellRouter}`);
            console.log(`🔸 Token: ${token.address}`);
            console.log(`🔸 Buy price: $${fmt(buyPrice)} | Sell price: $${fmt(sellPrice)}`);
            console.log(`🔸 Estimated gross profit: ${fmt(profitUSDC,6)} USDC`);

            // simulate + gas estimate
            const sim = await executeTrade(buyRouter, sellRouter, token.address, tradeAmountHuman);
            if (!sim.executed) {
              console.warn(`⚠️ Execution skipped/failed for ${symbol} ${buyName}->${sellName}: ${sim.reason || "callStatic or gas error"}`);
              continue;
            }

            // gas info
            const gasEstimate = sim.gasEstimate;
            const gasPrice = sim.gasPrice;
            const gasCostMatic = sim.gasCostMatic;
            const gasCostUSDCapprox = sim.gasCostUSDCapprox;
            console.log(`💸 Estimated gas: ${gasEstimate.toString()} | gasPrice: ${ethers.formatUnits(gasPrice, "gwei")} gwei => ${fmt(gasCostMatic)} MATIC${gasCostUSDCapprox ? ` ≈ ${fmt(gasCostUSDCapprox,6)} USDC` : ""}`);

            // estimated net profit after gas in USDC (if we have approximate conversion)
            let netProfitAfterGasUSDC = profitUSDC;
            if (gasCostUSDCapprox !== null && !isNaN(gasCostUSDCapprox)) {
              netProfitAfterGasUSDC = profitUSDC - gasCostUSDCapprox;
            } else {
              // we don't know MATIC->USDC, so we keep gross profit but log that gas in USDC unknown
              console.warn("⚠️ Could not estimate gas cost in USDC (QuickSwap price path unavailable). Net profit shown will not subtract gas.");
            }

            console.log(`🧮 Net profit after gas (approx): ${fmt(netProfitAfterGasUSDC,6)} USDC`);

            // require minimum net profit threshold
            if (netProfitAfterGasUSDC < MIN_NET_PROFIT_USDC) {
              console.log(`⚠️ Skipping trade: estimated net profit ${fmt(netProfitAfterGasUSDC)} USDC < MIN_NET_PROFIT_USDC (${MIN_NET_PROFIT_USDC})`);
              continue;
            }

            // show balances
            const contractBefore = await getContractUSDCBalance();
            const walletMaticBefore = await getWalletMaticBalance();
            console.log(`🏦 Contract USDC balance (before): ${fmt(contractBefore,6)} USDC`);
            console.log(`⏳ Wallet MATIC balance: ${fmt(walletMaticBefore,6)} MATIC`);

            // send tx (we already have populated tx inside sim.populated)
            try {
              const receipt = await sendTradeTx(sim.populated, tradeAmountHuman);
              console.log(`✅ Tx mined: ${receipt.transactionHash} | block ${receipt.blockNumber} | gasUsed: ${receipt.gasUsed.toString()}`);

              const contractAfter = await getContractUSDCBalance();
              const netChange = contractAfter - contractBefore;
              console.log(`🏦 Contract USDC balance (after): ${fmt(contractAfter,6)} USDC`);
              console.log(`💹 Net USDC change for contract this tx: ${fmt(netChange,6)} USDC`);
            } catch (sendErr) {
              console.error(`⚠️ Transaction failed to send / reverted: ${sendErr.reason || sendErr.message || sendErr}`);
            }

            // Add opportunity to list
            opportunities.push({
              token: symbol, buyName, sellName, buyPrice, sellPrice, grossProfit: profitUSDC, netProfitApprox: netProfitAfterGasUSDC
            });

          } // profit condition
        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyName}->${sellName}: ${e.message || e}`);
        }
      }
    }
  }

  console.log(`\n🔍 Scan pass finished. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  // startup sanity
  try {
    console.log("✅ Connected to contract:", CONTRACT_ADDRESS);
    const owner = await arbContract.owner();
    console.log("👤 Contract owner:", owner);
  } catch (e) {
    console.error("❌ Contract connection / ABI mismatch:", e.message || e);
    process.exit(1);
  }

  while (true) {
    try {
      await scanOnce(TRADE_AMOUNT_USDC);
    } catch (err) {
      console.error("⚠️ Scan error:", err.message || err);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});





