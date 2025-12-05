// improved-arbitrage.js
//🟢1 Imports core libraries
import { ethers, Wallet } from "ethers";        //🟢1 ethers for RPC, wallet, contracts
import fs from "fs";                            //🟢2 filesystem for CSV writing
import dotenv from "dotenv";                    //🟢3 load .env
dotenv.config();

// ---------- CONFIG ----------
//🟢4 Script mode (Dry-run or live)
const DRY_RUN = process.env.DRY_RUN === "true" ? true : false;
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

//🟢5 RPC endpoint + wallet config
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

//🟢6 Vault contract address (REPLACED with contract 2)
const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x7DadE334120e659eDE4999c8813c183648b1bd19";

//🟢7 Trading configuration (minimum profit, min trade, gas est.)
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.5);
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.01);
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);
const MIN_EXPECTED_PROFIT_SCRIPT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.2);

//🟢8 Router addresses
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

//🟢9 Token map
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

//🟢10 CSV logging helper
const csvRows = [];
function logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC }) {
  csvRows.push([timestamp, symbol, buyRouter, sellRouter, amount, profitUSDC].join(","));
}
function saveCSV() {
  if (csvRows.length === 0) return;
  const header = ["Timestamp","Token","BuyRouter","SellRouter","AmountUSDC","ProfitUSDC"];
  const filename = `arbitrage_log_${Date.now()}.csv`;
  fs.writeFileSync(filename, [header.join(","), ...csvRows].join("\n"));
  console.log(`💾 CSV exported: ${filename}`);
}

// ---------- PROVIDER + WALLET ----------
//🟢11 Provider
const provider = new ethers.JsonRpcProvider(RPC_URL);
//🟢12 Wallet only used in live mode
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT (Contract 2 ABI) ----------
//🟢13 Full ABI for contract 2 (enforces min profit on-chain)
const arbAbi = [
	{
		"inputs": [
			{ "internalType": "address", "name": "_usdc", "type": "address" },
			{ "internalType": "uint256", "name": "_minProfitUSDC", "type": "uint256" }
		],
		"stateMutability": "nonpayable",
		"type": "constructor"
	},
	{
		"anonymous": false,
		"inputs": [
			{ "indexed": true, "internalType": "address", "name": "executor", "type": "address" },
			{ "indexed": true, "internalType": "address", "name": "buyRouter", "type": "address" },
			{ "indexed": true, "internalType": "address", "name": "sellRouter", "type": "address" },
			{ "indexed": false, "internalType": "address", "name": "token", "type": "address" },
			{ "indexed": false, "internalType": "uint256", "name": "amountIn", "type": "uint256" },
			{ "indexed": false, "internalType": "uint256", "name": "beforeUSDC", "type": "uint256" },
			{ "indexed": false, "internalType": "uint256", "name": "afterUSDC", "type": "uint256" },
			{ "indexed": false, "internalType": "uint256", "name": "profitUSDC", "type": "uint256" }
		],
		"name": "ArbitrageExecuted",
		"type": "event"
	},
	{
		"inputs": [
			{ "internalType": "address", "name": "buyRouter", "type": "address" },
			{ "internalType": "address", "name": "sellRouter", "type": "address" },
			{ "internalType": "address", "name": "token", "type": "address" },
			{ "internalType": "uint256", "name": "amountInUSDC", "type": "uint256" },
			{ "internalType": "uint256", "name": "minReturnUSDC", "type": "uint256" }
		],
		"name": "executeArbitrage",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"anonymous": false,
		"inputs": [{ "indexed": false, "internalType": "uint256", "name": "newMinProfit", "type": "uint256" }],
		"name": "MinProfitUpdated",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{ "indexed": true, "internalType": "address", "name": "previousOwner", "type": "address" },
			{ "indexed": true, "internalType": "address", "name": "newOwner", "type": "address" }
		],
		"name": "OwnershipTransferred",
		"type": "event"
	},
	{ "anonymous": false, "inputs": [{ "indexed": false, "internalType": "bool", "name": "isPaused", "type": "bool" }], "name": "Paused", "type": "event" },
	{
		"anonymous": false,
		"inputs": [
			{ "indexed": false, "internalType": "address", "name": "token", "type": "address" },
			{ "indexed": false, "internalType": "address", "name": "to", "type": "address" },
			{ "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" }
		],
		"name": "Rescue",
		"type": "event"
	},
	{
		"inputs": [
			{ "internalType": "address", "name": "token", "type": "address" },
			{ "internalType": "address", "name": "to", "type": "address" },
			{ "internalType": "uint256", "name": "amount", "type": "uint256" }
		],
		"name": "rescueToken",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [{ "internalType": "uint256", "name": "_minProfitUSDC", "type": "uint256" }],
		"name": "setMinProfit",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [{ "internalType": "bool", "name": "_p", "type": "bool" }],
		"name": "setPaused",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [{ "internalType": "address", "name": "newOwner", "type": "address" }],
		"name": "transferOwnership",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "minProfitUSDC",
		"outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
		"stateMutability": "view",
		"type": "function"
	},
	{ "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
	{ "inputs": [], "name": "paused", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" },
	{
		"inputs": [],
		"name": "USDC",
		"outputs": [{ "internalType": "contract IERC20", "name": "", "type": "address" }],
		"stateMutability": "view",
		"type": "function"
	}
];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
                            : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

//🟢17 ERC20 balance checker
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

// store on-chain contract min profit (USDC decimals)
let CONTRACT_MIN_PROFIT_USDC = MIN_EXPECTED_PROFIT_SCRIPT;

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();      //🟢18 Read USDC address (view call)  ✅ static-call
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();        //🟢19 Get contract owner  ✅ static-call

    //🟢19b Read minProfitUSDC from contract (uint with 6 decimals assumed for USDC)
    try {
      const mp = await arbContract.minProfitUSDC();
      CONTRACT_MIN_PROFIT_USDC = Number(ethers.formatUnits(mp, 6)); // numeric USDC
      console.log(`🔒 Contract enforces minProfitUSDC (on-chain): ${CONTRACT_MIN_PROFIT_USDC} USDC`);
    } catch (mpErr) {
      console.warn("⚠️ Could not read on-chain minProfitUSDC:", mpErr.message);
    }

    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
  } catch (e) {
    console.warn("⚠️ Initialization warning:", e.message);
  }
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

//🟢20 Wrapper around router.getAmountsOut()  (price quotes)
async function getAmountOut(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],  //🟢21 view call  ✅ static-call
    provider
  );
  const usdcAddress = await arbContract.USDC();
  const path = [usdcAddress, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountUSDC.toString(), 6),
      path
    );
    return Number(ethers.formatUnits(amounts[1], token.decimals));
  } catch (err) {
    //🟢22 Fallback path
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountUSDC.toString(), 6),
      fallback
    );
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

//🟢23 Simple liquidity sanity check
async function priceSanityCheck(routerAddr, token, amountUSDC) {
  try {
    const out = await getAmountOut(routerAddr, token, amountUSDC);
    return out > 0 && Number.isFinite(out);
  } catch (e) {
    return false;
  }
}

// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;

//🟢24 Main executor function
async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase())
                   || { address: tokenAddr, decimals: 18 };

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    //🟢25 Check vault balance BEFORE trade  ✅ static-call
    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    //🟢26 Skip if too small
    if (amountUSDC < MIN_TRADE_USDC) {
      console.log(`⛔️ Skipping — Amount ${amountUSDC} < MIN_TRADE_USDC`);
      return;
    }

    //🟢27 Pre-trade price quotes  (view functions)  ✅ static-call
    let buyOut, sellOut;
    try {
      buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
      sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);
    } catch (err) {
      console.log("⚠️ Pre-price query failed — aborting trade");
      return;
    }

    //🟢28 Convert quotes → prices → expected profit  ✅ profit calculation
    const buyPrice  = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    let expectedProfitUSDC = sellPrice - buyPrice;

    // apply slippage guard
    expectedProfitUSDC *= (1 - SLIPPAGE_PCT/100);

    console.log(`📈 Quoted: buyPrice=${fmt(buyPrice,6)} | sellPrice=${fmt(sellPrice,6)} | expectedProfit=${fmt(expectedProfitUSDC,6)} USDC (after ${SLIPPAGE_PCT}% slippage)`);

    //🟢28b Enforce both script-floor and on-chain min profit
    const effectiveMinProfit = Math.max(MIN_EXPECTED_PROFIT_SCRIPT, CONTRACT_MIN_PROFIT_USDC);
    if (expectedProfitUSDC <= effectiveMinProfit) {
      console.log(`❌ PREVENTED — Expected profit ${fmt(expectedProfitUSDC)} <= effectiveMinProfit ${effectiveMinProfit}`);
      return;
    }

    //🟢30 Liquidity sanity
    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) ||
        !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed — aborting");
      return;
    }

    //🟢31 Gas cost check (estimate only)
    let gasEstimate = null;
    try {
      gasEstimate = await arbContract.estimateGas.executeArbitrage(
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6),
        ethers.parseUnits((expectedProfitUSDC).toString(), 6) // pass minReturnUSDC for estimate
      );
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits("1", "gwei");
      // Note: converting native gas -> USDC requires price oracle; we simply require a script-level GAS_EST_USDC minimum
      if (expectedProfitUSDC <= GAS_EST_USDC) {
        console.log(`❌ PREVENTED — expectedProfit ${fmt(expectedProfitUSDC)} ≤ GAS_EST_USDC ${GAS_EST_USDC} (conservative)`);
        return;
      }
    } catch (e) {
      console.warn("⚠️ Gas estimate failed — continuing but cautious:", e.message);
    }

    //🟢32 Simulate execution (callStatic)  ✅ static-call
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [
          buyRouter,
          sellRouter,
          tokenAddr,
          ethers.parseUnits(amountUSDC.toString(), 6),
          ethers.parseUnits((expectedProfitUSDC).toString(), 6) // minReturnUSDC param for simulation
        ]),
        from: wallet ? wallet.address : undefined
      });
      console.log("🔬 Simulation OK — executeArbitrage callStatic passed");
    } catch (simErr) {
      console.log("❌ SIMULATION FAILED — Contract would revert:", (simErr && simErr.message) ? simErr.message.split("\n")[0] : simErr);
      console.log("❌ Trade aborted — vault remains unchanged");
      return;
    }

    // ready to run
    console.log(`💥 PROFITABLE SIGNAL — expected net profit (est) ${fmt(expectedProfitUSDC)} USDC`);

    if (DRY_RUN) {
      console.log("🧪 DRY_RUN: would execute, but not sending tx (stopping here).");
      return;
    }

    //🟢33 Execute transaction (pass minReturnUSDC)
    console.log("🚀 Executing arbitrage (on-chain) — sending tx...");
    let tx;
    try {
      tx = await arbContract.executeArbitrage(
        buyRouter,
        sellRouter,
        tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6),
        ethers.parseUnits((expectedProfitUSDC).toString(), 6),
        { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined }
      );
    } catch (sendErr) {
      console.error("❌ Failed to send tx:", sendErr.message || sendErr);
      return;
    }

    if (!tx || !tx.hash) {
      console.error("❌ Tx did not return a hash — aborting post-checks. Vault unchanged.");
      return;
    }
    console.log(`🔁 TX SENT — hash: ${tx.hash} — waiting for confirmation...`);

    //🟢34 Wait for receipt + verify status
    const receipt = await tx.wait();
    if (!receipt || (!('status' in receipt) ? false : receipt.status === 0)) {
      console.log("❌ Transaction reverted or failed on-chain — vault unchanged");
      return;
    }
    console.log(`✅ Transaction success — txHash ${receipt.transactionHash} • gasUsed ${receipt.gasUsed?.toString() || "n/a"}`);

    //🟢35 After-trade vault balance verification (Option 5)  ✅ static-call
    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    console.log(`🏦 Vault Balance After: ${fmt(after)} USDC`);

    if (after <= before) {
      console.log("❌ Trade resulted in no net vault increase — treated as failed/ignored (Option 5)");
      return;
    }

    //🟢36 Real net profit (+ logging)  ✅ profit calculation
    const netProfit = after - before;
    console.log(`💰 REAL Net Profit This Trade: ${fmt(netProfit)} USDC`);
    cumulativeProfit += netProfit;
    console.log(`📊 Cumulative Profit: ${fmt(cumulativeProfit)} USDC`);

    //🟢37 Persist the trade to CSV
    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({
      timestamp,
      symbol,
      buyRouter,
      sellRouter,
      amount: amountUSDC,
      profitUSDC: netProfit
    });
    console.log("🗂 Trade logged to CSV buffer");

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message || err);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01); //🟢38 Single-scan trade amount

async function scanOnce() {
  console.log("\n🔍 Scanning for arbitrage opportunities...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          //🟢39 getAmountsOut (both routers)  ✅ static-call
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          //🟢40 profit calculations  ✅ profit calculation
          const buyPrice  = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          let profitPct = (profitUSDC / buyPrice) * 100;

          console.log(`${symbol} | ${buyName} → ${sellName} | buy=${fmt(buyPrice)} sell=${fmt(sellPrice)} | profit=${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%)`);

          // extra conservative guard against very small or negative computed profit
          const effectiveMinProfitPct = MIN_PROFIT_PCT;
          if (profitPct >= effectiveMinProfitPct && profitUSDC > 0) {
            // ensure expected profit meets on-chain minimum before attempting execution
            if (profitUSDC >= CONTRACT_MIN_PROFIT_USDC) {
              console.log(`🚨 PROFITABLE: ${symbol} | ${buyName} → ${sellName} | est ${fmt(profitUSDC)} USDC (${fmt(profitPct,2)}%) — executing`);
              opportunities.push({ symbol, tokenAddr: token.address, buyRouter, sellRouter, buyName, sellName, profitUSDC });
              // execute with internal checks in executeTradeLive
              await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
            } else {
              console.log(`⚠️ Skipping — profit ${fmt(profitUSDC)} USDC < on-chain min ${CONTRACT_MIN_PROFIT_USDC} USDC`);
            }
          }
        } catch (e) {
          console.warn(`⚠️ Scan error for ${symbol} ${buyName}->${sellName}:`, e.message || e);
        }
      }
    }
  }

  saveCSV();
  console.log(`🔍 Scan complete — found ${opportunities.length} candidate opportunities.`);
  return opportunities;
}

// ---------- MAIN ----------
(async function main(){
  await init();
  console.log("🚀 Improved arbitrage runner started");
  // single scan for safety here; adapt loop as needed
  try {
    await scanOnce();
  } catch (e) {
    console.error("Fatal scanner error:", e.message || e);
  }
})();
