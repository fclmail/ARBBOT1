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

//🟢6 Vault contract address
const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

//🟢7 Trading configuration (minimum profit, min trade, gas est.)
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.5);     
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.01);    
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.002);     
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
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

// ---------- VAULT CONTRACT ----------
//🟢13 Minimal ABI for arbitrage vault
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
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },   //🟢14
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, //🟢15
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" } //🟢16
];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
                            : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

//🟢17 ERC20 balance checker
let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();      //🟢18 Read USDC address (view call)  ✅ static-call
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();        //🟢19 Get contract owner  ✅ static-call
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

    expectedProfitUSDC *= (1 - SLIPPAGE_PCT/100);  // slippage adjustment

    console.log(
      `📈 Quoted: buyPrice=${fmt(buyPrice)} | sellPrice=${fmt(sellPrice)} | expectedProfit=${fmt(expectedProfitUSDC)}`
    );

    //🟢29 Reject if not profitable
    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT) {
      console.log("❌ PREVENTED — Not enough expected profit");
      return;
    }

    //🟢30 Liquidity sanity
    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) ||
        !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed");
      return;
    }

    //🟢31 Gas cost check (estimate only)
    let gasEstimate = null;
    let gasPrice = null;
    try {
      gasEstimate = await arbContract.estimateGas.executeArbitrage(
        buyRouter, sellRouter, tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6)
      );
      const feeData = await provider.getFeeData();
      gasPrice = feeData.gasPrice;

      if (expectedProfitUSDC <= GAS_EST_USDC) {
        console.log("❌ PREVENTED — Not enough profit after gas est");
        return;
      }
    } catch (e) {
      console.warn("⚠️ Gas estimate failed, continuing");
    }

    //🟢32 Simulate execution (callStatic)  ✅ static-call
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
      console.log("❌ SIM FAILED — would revert");
      return;
    }

    console.log(`💥 PROFITABLE SIGNAL — est profit ${fmt(expectedProfitUSDC)} USDC`);

    if (DRY_RUN) {
      console.log("🧪 DRY RUN — not sending tx");
      return;
    }

    //🟢33 Real transaction execution
    console.log("🚀 Executing arbitrage on-chain...");
    let tx;
    try {
      tx = await arbContract.executeArbitrage(
        buyRouter,
        sellRouter,
        tokenAddr,
        ethers.parseUnits(amountUSDC.toString(), 6),
        { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined }
      );
    } catch (sendErr) {
      console.error("❌ Failed to send tx");
      return;
    }
    console.log(`🔁 TX SENT — ${tx.hash}`);

    //🟢34 Wait for receipt
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ TX failed");
      return;
    }
    console.log(`✅ Transaction success — ${receipt.transactionHash}`);

    //🟢35 Balance AFTER  (view call)  ✅ static-call
    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    console.log(`🏦 Vault After: ${fmt(after)} USDC`);

    //🟢36 Realized profit  ✅ profit calculation
    if (after <= before) {
      console.log("⚠️ No net profit — ignored");
      return;
    }
    const netProfit = after - before;
    console.log(`💰 REAL PROFIT: ${fmt(netProfit)}`);
    cumulativeProfit += netProfit;

    //🟢37 Log to CSV buffer
    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || 0.01); //🟢38 Single-scan trade amount

async function scanOnce() {
  console.log("\n🔍 Scanning...");
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

          console.log(`${symbol} | ${buyName}→${sellName} | profit=${fmt(profitUSDC)} USDC`);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`🚨 PROFITABLE — executing`);
            opportunities.push({ symbol, tokenAddr: token.address, buyRouter, sellRouter });
            await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn("scan error:", e.message);
        }
      }
    }
  }

  saveCSV();
  return opportunities;
}

// ---------- MAIN ----------
(async function main(){
  await init();                                    //🟢41 Setup USDC + owner info
  console.log("🚀 Improved arbitrage runner started");
  try {
    await scanOnce();                              //🟢42 Single arbitrage scan
  } catch (e) {
    console.error("Fatal scanner error:", e.message);
  }
})();
