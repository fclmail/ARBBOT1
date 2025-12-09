//🟢1 🟢sy Mobil Imports core libraries: ethers (RPC + contracts) and Wallet constructor for signing.
import { ethers, Wallet } from "ethers";        // ethers for RPC, wallet, contracts

//🟢2 🟢sy Mobil Node filesystem used later to write CSV logs to disk.
import fs from "fs";                            // filesystem for CSV writing

//🟢3 🟢sy Mobil dotenv loads environment variables from a .env file into process.env.
import dotenv from "dotenv";                    // load .env
dotenv.config();

// ---------- CONFIG ----------

//🟢4 🟢sy Mobil DRY_RUN toggles whether the script performs on-chain transactions or simulates only.
const DRY_RUN = process.env.DRY_RUN === "true" ? true : true;
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

//🟢5 🟢sy Mobil RPC endpoint and private key configuration. PRIVATE_KEY is required for live mode.
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

//🟢6 🟢sy Mobil Vault contract address - where executeArbitrage is expected to be called.
const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

//🟢7 🟢sy Mobil Trading and safety configuration. MIN/TARGET values are read from env or defaulted.
// MIN_PROFIT_PCT — threshold to consider executing a trade in scanner.
// MIN_TRADE_USDC — smallest trade size accepted.
// GAS_EST_USDC — (unused numeric estimate placeholder) could be used to convert gas into USDC.
// MIN_EXPECTED_PROFIT — absolute minimum expected profit in USDC to attempt a trade.
// SLIPPAGE_PCT — applied to expected profit calculation to be conservative.
// MAX_PROFIT_PCT — a safety cap preventing obviously suspiciously-large quoted profits.
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 20);     
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 1);    
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);     
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.001);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.0);
const MAX_PROFIT_PCT = 40; // 🔹 new maximum profit cap

//🟢8 🟢sy Mobil Known router addresses on Polygon - used for quoting getAmountsOut.
// These are on-chain router contract addresses (QuickSwap, SushiSwap, ApeSwap).
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

//🟢9 🟢sy Mobil Token map for assets we will scan. Each token stores address + decimals used for formatting.
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

//🟢10 🟢sy Mobil CSV logging helpers - accumulate rows and flush to file at the end of a scanning run.
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  //🟢11 🟢sy Mobil Add a CSV row (no header here) so saveCSV can write header + rows.
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  //🟢12 🟢sy Mobil If no rows collected, nothing to save.
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  //🟢13 🟢sy Mobil Write header + rows to disk synchronously (simple and reliable).
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------

//🟢14 🟢sy Mobil Provider connects to the configured JSON-RPC endpoint for onchain queries and calls.
const provider = new ethers.JsonRpcProvider(RPC_URL);

//🟢15 🟢sy Mobil Wallet is created only when not in DRY_RUN so we don't risk exposing private key in tests.
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------

//🟢16 🟢sy Mobil Minimal ABI for the vault contract - only functions we call are included (executeArbitrage, USDC, owner, minProfit).
const arbAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },   //🟢17 🟢sy Mobil USDC accessor returns the vault's USDC token address.
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, //🟢18 🟢sy Mobil owner accessor useful for auditing and permissions checks.
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" } //🟢19 🟢sy Mobil Optional config exposed by contract (not used directly now).
];

//🟢20 🟢sy Mobil Create a contract instance connected to provider or wallet depending on DRY_RUN.
const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
                            : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

//🟢21 🟢sy Mobil ERC20 minimal ABI used to read balances and decimals for USDC-like tokens.
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

//🟢22 🟢sy Mobil init() reads the vault's USDC token address and contract owner for logging.
// It also assigns usdcContract for balance reads used before/after trades.
async function init() {
  try {
    //🟢23 🟢sy Mobil Read the vault's USDC token address via the contract accessor (may revert if contract inaccessible).
    const usdcAddr = await arbContract.USDC();      // Read USDC address
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    //🟢24 🟢sy Mobil Read the vault contract owner for audit/logging purposes.
    const owner = await arbContract.owner();        // Get contract owner
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
  } catch (e) {
    //🟢25 🟢sy Mobil Initialization warning printed but does not stop execution — useful for non-critical failures.
    console.warn("⚠️ Initialization warning:", e.message);
  }
}

// ---------- HELPERS ----------

//🟢26 🟢sy Mobil fmt utility for human-readable numeric printing with default decimal places.
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

//🟢27 🟢sy Mobil getAmountOut is a wrapper around a router's getAmountsOut to quote token output for a USDC input.
// It uses the vault's USDC address, constructs a path, and returns the token amount as a human number.
async function getAmountOut(routerAddr, token, amountUSDC) {
  //🟢28 🟢sy Mobil Instantiate a light router interface with getAmountsOut only — gas cheap for view calls.
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  //🟢29 🟢sy Mobil Obtain USDC address from the vault on each call to ensure consistency if vault changes token.
  const usdcAddress = await arbContract.USDC();
  //🟢30 🟢sy Mobil Primary path is USDC -> token. We use token.decimals to format result into human units.
  const path = [usdcAddress, token.address];
  try {
    //🟢31 🟢sy Mobil Attempt primary quote: parse USDC to its 6 decimals on-chain representation.
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountUSDC.toString(), 6),
      path
    );
    //🟢32 🟢sy Mobil Return the quoted token amount converted to human units using token decimals.
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    //🟢33 🟢sy Mobil Fallback path adds WBTC as intermediary if direct pool doesn't exist; this helps for thin pairs.
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountUSDC.toString(), 6),
      fallback
    );
    //🟢34 🟢sy Mobil Return the third value from fallback route formatted to token decimals.
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

//🟢35 🟢sy Mobil priceSanityCheck calls getAmountOut and enforces the result is a finite positive value.
// This prevents trying trades with zero liquidity or faulty router responses.
async function priceSanityCheck(routerAddr, token, amountUSDC) {
  try {
    const out = await getAmountOut(routerAddr, token, amountUSDC);
    return out > 0 && Number.isFinite(out);
  } catch (e) {
    return false;
  }
}

// ---------- CORE TRADE EXECUTION ----------

//🟢36 🟢sy Mobil cumulativeProfit tracks realized profit from this process during runtime for monitoring.
let cumulativeProfit = 0;

//🟢37 🟢sy Mobil executeTradeLive is the core routine that simulates, optionally sends, and logs an arbitrage execution.
// Parameters:
// - buyRouter, sellRouter: addresses of routers to buy/sell on.
// - tokenAddr: token to arbitrage.
// - amountUSDC: USDC amount input size (human units).
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  //🟢38 🟢sy Mobil Human-readable ISO timestamp for logs and CSV rows.
  const timestamp = new Date().toISOString();
  //🟢39 🟢sy Mobil Map tokenAddr back to tokens map entry if available; default decimals 18 if unknown.
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) 
                   || { address: tokenAddr, decimals: 18 };

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    //🟢40 🟢sy Mobil Read vault USDC balance before the trade to compute net profit later.
    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    //🟢41 🟢sy Mobil Skip very small trade sizes below configured minimum to avoid dust or unprofitable rounds.
    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
      return;
    }

    let buyOut, sellOut;
    try {
      //🟢42 🟢sy Mobil Quote how many tokens we'd receive buying with amountUSDC on buyRouter and sellRouter.
      buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
      sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
    } catch (err) {
      //🟢43 🟢sy Mobil If quoting fails, abort this execution attempt — likely lack of liquidity or router error.
      console.log("⚠️ Pre-price query failed — aborting trade");
      return;
    }

    //🟢44 🟢sy Mobil Compute implied buyPrice and sellPrice in USDC per 1 token using amountUSDC / tokenAmount.
    const buyPrice  = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    let expectedProfitUSDC = sellPrice - buyPrice;
    //🟢45 🟢sy Mobil Apply slippage buffer (percentage) to expected profit to be conservative.
    expectedProfitUSDC *= (1 - SLIPPAGE_PCT/100);

    //🟢46 🟢sy Mobil expectedProfitPct expresses profit relative to buyPrice; this is used for profit caps / filtering.
    const expectedProfitPct = (expectedProfitUSDC / buyPrice) * 100;
    if (expectedProfitPct > MAX_PROFIT_PCT) {
      //🟢47 🟢sy Mobil Safety: skip trades with unrealistically high quoted profit (could be oracle or flash pool glitch).
      console.log(`⚠️ Skipping — profit ${fmt(expectedProfitPct)}% exceeds 40% cap`);
      return;
    }

    console.log(`📈 Quoted: buyPrice=${fmt(buyPrice)} | sellPrice=${fmt(sellPrice)} | expectedProfit=${fmt(expectedProfitUSDC)} USDC`);

    //🟢48 🟢sy Mobil Require a minimum absolute expected profit to attempt trade — avoids tiny noise trades.
    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      console.log("❌ PREVENTED — Not enough expected profit");
      return;
    }

    //🟢49 🟢sy Mobil Confirm both price quotes look sane before gas estimation and simulation.
    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) ||
        !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed");
      return;
    }

    //🟢50 🟢sy Mobil Try to estimate gas for executeArbitrage. If it fails we still attempt a simulation call below.
    let gasEstimate = null;
    try {
      gasEstimate = await arbContract.estimateGas.executeArbitrage(
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6)
      );
    } catch (e) {
      console.warn("⚠️ Gas estimate failed, continuing");
    }

    //🟢51 🟢sy Mobil Use provider.call to simulate the transaction with encoded calldata to detect reverts before sending.
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [
          buyRouter, sellRouter, tokenAddr,
          ethers.parseUnits(amountUSDC.toString(), 6),
        ]),
        from: wallet ? wallet.address : undefined
      });
      console.log("🔬 Simulation OK");
    } catch (simErr) {
      //🟢52 🟢sy Mobil If simulation reverts, it means on-chain execution would revert — aborting to avoid failed tx.
      console.log("❌ SIM FAILED — would revert");
      return;
    }

    //🟢53 🟢sy Mobil If in DRY_RUN mode we stop here after simulation to avoid actual on-chain side effects.
    if (DRY_RUN) {
      console.log("🧪 DRY RUN — not sending tx");
      return;
    }

    //🟢54 🟢sy Mobil Attempt to send executeArbitrage transaction with a safety gasLimit multiplier (120%).
    let tx;
    try {
      tx = await arbContract.executeArbitrage(
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6),
        { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined }
      );
    } catch (sendErr) {
      //🟢55 🟢sy Mobil Catch sending errors (e.g., insufficient funds, revert before mining) and log.
      console.error("❌ Failed to send tx");
      return;
    }
    console.log(`🔁 TX SENT — ${tx.hash}`);

    //🟢56 🟢sy Mobil Await confirmation and check receipt status to confirm success.
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ TX failed");
      return;
    }
    console.log(`✅ Transaction success — ${receipt.transactionHash}`);

    //🟢57 🟢sy Mobil Read vault USDC balance after the trade and compare to before to compute actual net profit.
    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    console.log(`🏦 Vault After: ${fmt(after)} USDC`);

    //🟢58 🟢sy Mobil If vault balance did not increase, the trade realized no profit (or was refunded).
    if (after <= before) {
      console.log("⚠️ No net profit — ignored");
      return;
    }

    //🟢59 🟢sy Mobil Compute netProfit, update cumulativeProfit for runtime monitoring, and log CSV row.
    const netProfit = after - before;
    console.log(`💰 REAL PROFIT: ${fmt(netProfit)}`);
    cumulativeProfit += netProfit;

    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });

  } catch (err) {
    //🟢60 🟢sy Mobil Catch-all for unexpected runtime errors in a trade; log message for debugging.
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}

// ---------- SCAN LOOP ----------

//🟢61 🟢sy Mobil TRADE_AMOUNT_USDC is the per-trade quoting size for scanning (human units).
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 1); 

//🟢62 🟢sy Mobil scanAllPairs iterates tokens and router pairs, computes quoted profit, and delegates to executeTradeLive if profitable.
async function scanAllPairs() {
  console.log("\n🔍 Scanning all tokens & routers...");
  //🟢63 🟢sy Mobil Loop every configured token.
  for (const [symbol, token] of Object.entries(tokens)) {
    //🟢64 🟢sy Mobil Nested loops over routers for buy and sell combos.
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        //🟢65 🟢sy Mobil Skip identical router trades (no arbitrage opportunity).
        if (buyName === sellName) continue;
        try {
          //🟢66 🟢sy Mobil Quote how many tokens we'd receive buying with TRADE_AMOUNT_USDC on both routers.
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          //🟢67 🟢sy Mobil Convert token outputs into implied USDC-per-token prices and compute profit.
          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          let profitPct = (profitUSDC / buyPrice) * 100;

          //🟢68 🟢sy Mobil Enforce profit cap to avoid replying on suspicious quotes.
          if (profitPct > MAX_PROFIT_PCT) continue;

          //🟢69 🟢sy Mobil Log candidate opportunity for human visibility (will be verbose).
          console.log(`${symbol} | ${buyName}→${sellName} | profit=${fmt(profitUSDC)} USDC | profitPct=${fmt(profitPct)}%`);

          //🟢70 🟢sy Mobil If profit percentage exceeds configured minimum threshold, attempt to execute trade.
          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 PROFITABLE — executing`);
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          //🟢71 🟢sy Mobil Non-fatal scan errors logged and the loop continues scanning other pairs.
          console.warn(`${symbol} | ${buyName}→${sellName} | scan error:`, e.message);
        }
      }
    }
  }
  //🟢72 🟢sy Mobil After scanning all pairs, export CSV to disk for record keeping.
  saveCSV();
}

// ---------- MAIN ----------

//🟢73 🟢sy Mobil IIFE main bootstraps init and starts a continuous scanning interval loop.
(async function main(){
  await init();
  console.log("🚀 Improved arbitrage runner started");

  //🟢74 🟢sy Mobil setInterval creates a repeating task every 10 seconds to scan the market.
//🟢75 🟢sy Mobil Note: setInterval callback is async — any thrown errors handled inside to avoid unhandled rejections.
  setInterval(async () => {
    try {
      await scanAllPairs();
    } catch (e) {
      //🟢76 🟢sy Mobil Fatal scanner error logged; process continues to attempt next interval iteration.
      console.error("Fatal scanner error:", e.message);
    }
  }, 10000); // 🔹 10 seconds
})();
