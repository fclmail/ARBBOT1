// improved-arbitrage.js
//🟢1 Imports core libraries
import { ethers, Wallet } from "ethers";        
import fs from "fs";                            
import dotenv from "dotenv";                    
dotenv.config();

// ---------- CONFIG ----------
const DRY_RUN = process.env.DRY_RUN === "true" ? true : false;
console.log(DRY_RUN ? "🔬 DRY RUN — NO ON-CHAIN TRANSACTIONS" : "🚀 LIVE MODE ENABLED — REAL TRADES WILL BE EXECUTED");

const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
if (!DRY_RUN && !PRIVATE_KEY) throw new Error("PRIVATE_KEY required for live mode");

const CONTRACT_ADDRESS = process.env.VAULT_CONTRACT || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Trading configuration
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.0005);     
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || .05);    
const GAS_EST_USDC = Number(process.env.GAS_EST_USDC || 0.02);     
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.0001);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.0002);
const MAX_PROFIT_PCT = 40;

// Router addresses
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// Token map
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// CSV logging helper
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
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new Wallet(PRIVATE_KEY, provider);

// ---------- VAULT CONTRACT ----------
const arbAbi = [
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
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = DRY_RUN ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider)
                            : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

let usdcContract;
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"];

async function init() {
  try {
    const usdcAddr = await arbContract.USDC();
    usdcContract = new ethers.Contract(usdcAddr, erc20Abi, provider);
    const owner = await arbContract.owner();
    console.log("🏛 Contract Address:", CONTRACT_ADDRESS);
    console.log("👤 Contract Owner:", owner);
  } catch (e) {
    console.warn("⚠️ Initialization warning:", e.message);
  }
}

// ---------- HELPERS ----------
function fmt(n, dec = 6) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
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
  } catch {
    const fallback = [usdcAddress, tokens.WBTC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountUSDC.toString(), 6),
      fallback
    );
    return Number(ethers.formatUnits(amounts[2], token.decimals));
  }
}

async function priceSanityCheck(routerAddr, token, amountUSDC) {
  try {
    const out = await getAmountOut(routerAddr, token, amountUSDC);
    return out > 0 && Number.isFinite(out);
  } catch {
    return false;
  }
}

// ---------- CORE TRADE EXECUTION ----------
let cumulativeProfit = 0;

async function executeTradeLive(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  const timestamp = new Date().toISOString();
  const tokenObj = Object.values(tokens).find(t => t.address.toLowerCase() === tokenAddr.toLowerCase()) 
                   || { address: tokenAddr, decimals: 18 };
  const buyName = Object.entries(routers).find(([k,v]) => v.toLowerCase() === buyRouter.toLowerCase())[0];
  const sellName = Object.entries(routers).find(([k,v]) => v.toLowerCase() === sellRouter.toLowerCase())[0];

  try {
    console.log("\n🔍 ---------- New Trade Attempt ----------");
    console.log(`🔹 ${timestamp} • Token: ${tokenAddr} • AmountIn: ${amountUSDC} USDC`);

    const beforeBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const before = Number(ethers.formatUnits(beforeBal, 6));
    console.log(`🏦 Vault Balance Before: ${fmt(before)} USDC`);

    if (amountUSDC < MIN_TRADE_USDC || amountUSDC > before) return;

    const buyOut = await getAmountOut(buyRouter, tokenObj, amountUSDC);
    const sellOut = await getAmountOut(sellRouter, tokenObj, amountUSDC);

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    const expectedProfitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
    const expectedProfitPct = (expectedProfitUSDC / buyPrice) * 100;

    console.log(`💹 DEX: ${buyName} → ${sellName} | Token: ${tokenAddr}`);
    console.log(`📈 Buy Price: ${fmt(buyPrice)} | Sell Price: ${fmt(sellPrice)} | Expected Profit: ${fmt(expectedProfitUSDC)} USDC`);

    if (expectedProfitUSDC <= MIN_EXPECTED_PROFIT || expectedProfitPct > MAX_PROFIT_PCT) {
      console.log("❌ PREVENTED — Not profitable or exceeds max profit cap");
      return;
    }

    if (!await priceSanityCheck(buyRouter, tokenObj, amountUSDC) ||
        !await priceSanityCheck(sellRouter, tokenObj, amountUSDC)) {
      console.log("⚠️ Price sanity check failed");
      return;
    }

    // -------------------------------
    // ADD minReturnUSDC for safety
    // -------------------------------
  const minReturnUSDC = ethers.parseUnits("0.0001", 6);
  

    // Simulation
    try {
      await provider.call({
        to: CONTRACT_ADDRESS,
        data: arbContract.interface.encodeFunctionData("executeArbitrage", [
          buyRouter,
          sellRouter,
          tokenAddr,
          ethers.parseUnits(amountUSDC.toString(), 6),
          minReturnUSDC
        ]),
        from: wallet ? wallet.address : undefined
      });
      console.log("🔬 Simulation PASS ✅");
    } catch (err) {
      console.log("❌ SIM FAILED — would revert");
      console.log("🔹 Detailed Simulation Debug Info 🔹");
      console.log("  Token Address:", tokenAddr);
      console.log("  Token Decimals:", tokenObj.decimals);
      console.log("  AmountIn USDC:", amountUSDC);
      console.log("  AmountIn (parseUnits):", ethers.parseUnits(amountUSDC.toFixed(6), 6).toString());
      console.log("  minReturnUSDC (units):", minReturnUSDC.toString());
      console.log("  Buy Router:", buyName, buyRouter);
      console.log("  Sell Router:", sellName, sellRouter);
      console.log("  Error:", err.reason || err.message || err);
      return;
    }

    if (DRY_RUN) return;

    // Gas estimate
    const gasEstimate = await arbContract.estimateGas.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6),
      minReturnUSDC
    ).catch(() => null);

    // Execute TX
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), 6),
      minReturnUSDC,
      { gasLimit: gasEstimate ? gasEstimate.mul(120).div(100) : undefined }
    );
    console.log(`🔁 TX SENT — ${tx.hash}`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      console.log("❌ TX failed");
      return;
    }
    console.log(`✅ Trade SUCCESS — ${receipt.transactionHash}`);

    const afterBal = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const after = Number(ethers.formatUnits(afterBal, 6));
    const netProfit = after - before;
    if (netProfit <= 0) {
      console.log("⚠️ No net profit — ignored");
      return;
    }

    console.log(`💰 REAL NET PROFIT: ${fmt(netProfit)} USDC`);
    cumulativeProfit += netProfit;

    const symbolEntry = Object.entries(tokens).find(([k,t]) => t.address.toLowerCase() === tokenAddr.toLowerCase());
    const symbol = symbolEntry ? symbolEntry[0] : tokenAddr;
    logTradeCSV({ timestamp, symbol, buyRouter, sellRouter, amount: amountUSDC, profitUSDC: netProfit });

  } catch (err) {
    console.error("⚠️ Unexpected trade error:", err.message);
  }
}

// ---------- SCAN LOOP ----------
const TRADE_AMOUNT_USDC = Number(process.env.TRADE_AMOUNT_USDC || .05);

async function scanAllPairs() {
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          let profitPct = (profitUSDC / buyPrice) * 100;
          if (profitPct < MIN_PROFIT_PCT || profitPct > MAX_PROFIT_PCT) continue;
          await executeTradeLive(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
        } catch {}
      }
    }
  }
  saveCSV();
}

// ---------- MAIN ----------
(async function main() {
  await init();
  console.log("🚀 Improved vault-only arbitrage runner started");
  setInterval(async () => {
    try { await scanAllPairs(); } catch (e) { console.error(e); }
  }, 10000);
})();
