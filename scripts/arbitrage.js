// scripts/arb.js
// Aave Flash Arb bot — uses your deployed contract ABI + callStatic + gas/profit logging
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in environment");

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // hardcoded deployed contract
const MATIC_USD = Number(process.env.MATIC_USD || 0.75); // used to convert gas -> USDC, set to market value
const SCAN_INTERVAL_MS = 40_000; // 40 seconds

// Trading / safety settings (tweak as needed)
const TRADE_AMOUNT_USDC = 10.0;       // trade amount (human)
const MIN_PROFIT_PCT = 3.0;           // require >= this % profit to consider
const SLIPPAGE_PCT = 0;               // slippage factor to apply to profit estimate
const MIN_NET_PROFIT_USDC = 0.01;     // require at least this net profit after gas (USDC)
const MIN_CONTRACT_USDC_BUFFER = 0.02; // contract must hold at least this USDC (buffer for premiums/rounding)
const GAS_USAGE_FALLBACK = 1_000_000n; // fallback gas estimate (BigInt)

// ─────────────── PROVIDER & WALLET ───────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── ABI (your deployed contract) ───────────────
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
  {
    "inputs": [
      { "internalType": "address", "name": "asset", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "internalType": "uint256", "name": "premium", "type": "uint256" },
      { "internalType": "address", "name": "", "type": "address" },
      { "internalType": "bytes", "name": "params", "type": "bytes" }
    ],
    "name": "executeOperation",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  { "inputs": [{ "internalType": "uint256", "name": "_minProfit", "type": "uint256" }], "name": "setMinProfit", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
  { "inputs": [], "name": "AAVE_POOL", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "minProfit", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet);

// ─────────────── Routers & tokens (validate, skip bad addresses) ───────────────
const rawRouters = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76d3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const rawTokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:  { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  MATICX:{address:"0xa3fa99a148fa48d14ed51d610c367c61876997f1",decimals:18},
  QUICK:{address:"0x831753dd7087cac61ab5644b308642cc1c33dc13",decimals:18},
  UNI:{address:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",decimals:18},
  USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
  WBTC:{address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",decimals:8},
  WETH:{address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",decimals:18}
};

const routers = {};
for (const [k,v] of Object.entries(rawRouters)) {
  try {
    routers[k] = ethers.getAddress(v);
  } catch (e) {
    console.warn(`⚠️ Skipping invalid router address for ${k}: ${v}`);
  }
}
const tokens = {};
for (const [k,v] of Object.entries(rawTokens)) {
  try {
    tokens[k] = { address: ethers.getAddress(v.address), decimals: v.decimals };
  } catch (e) {
    console.warn(`⚠️ Skipping invalid token address for ${k}: ${v.address}`);
  }
}

// ─────────────── Helpers ───────────────
const fmt = (n,d=6) => Number(n).toFixed(d);

// getAmountsOut helper: returns token units (not USDC)
async function getAmountOut(routerAddr, tokenObj, amountUsdc) {
  const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
  const usdcAddr = await arbContract.USDC();
  let path = [usdcAddr, tokenObj.address];
  try {
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountUsdc.toString(), 6), path);
    return Number(ethers.formatUnits(amounts[amounts.length - 1], tokenObj.decimals));
  } catch (e) {
    // fallback via WETH
    path = [usdcAddr, tokens.WETH.address, tokenObj.address];
    const amounts2 = await router.getAmountsOut(ethers.parseUnits(amountUsdc.toString(), 6), path);
    return Number(ethers.formatUnits(amounts2[amounts2.length - 1], tokenObj.decimals));
  }
}

// Estimate gas cost and convert to USDC using MATIC_USD
async function estimateGasCostUsdc(populatedTx) {
  let gasEstimate;
  try {
    gasEstimate = await wallet.estimateGas(populatedTx);
  } catch {
    gasEstimate = GAS_USAGE_FALLBACK;
  }
  const gasPrice = await provider.getGasPrice(); // BigInt (wei)
  const gasWei = gasEstimate * gasPrice;          // BigInt
  const gasMatic = Number(ethers.formatUnits(gasWei, 18)); // MATIC
  const gasUsdc = gasMatic * MATIC_USD;
  return { gasEstimate, gasPrice, gasMatic, gasUsdc };
}

// return wallet MATIC balance (number)
async function getWalletMatic() {
  const b = await provider.getBalance(await wallet.getAddress());
  return Number(ethers.formatUnits(b, 18));
}

// ─────────────── Execute trade function ───────────────
async function executeTrade(buyRouter, sellRouter, tokenObj, amountUsd) {
  try {
    const usdcAddr = await arbContract.USDC();
    const usdcContract = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);

    const preBalBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const preBal = Number(ethers.formatUnits(preBalBN, 6));

    // Build tx
    const parsedAmt = ethers.parseUnits(amountUsd.toString(), 6);
    const populated = await arbContract.populateTransaction.executeArbitrage(buyRouter, sellRouter, tokenObj.address, parsedAmt);

    // Gas estimate -> USDC
    const { gasEstimate, gasPrice, gasMatic, gasUsdc } = await estimateGasCostUsdc(populated);

    // Compute buy/sell price estimates to re-log (getAmountOut)
    const buyOut = await getAmountOut(buyRouter, tokenObj, amountUsd);
    const sellOut = await getAmountOut(sellRouter, tokenObj, amountUsd);
    const buyPrice = amountUsd / buyOut;
    const sellPrice = amountUsd / sellOut;
    const grossProfit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
    const netProfit = grossProfit - gasUsdc;

    // Logging preconditions
    const walletMatic = await getWalletMatic();
    console.log("------------------------------------------------------------");
    console.log(`🔹 Opportunity: Buy on ${buyRouter} / Sell on ${sellRouter}`);
    console.log(`🔸 Token: ${tokenObj.address}`);
    console.log(`🔸 Buy price: $${fmt(buyPrice,6)} | Sell price: $${fmt(sellPrice,6)}`);
    console.log(`🔸 Estimated gross profit: ${fmt(grossProfit,6)} USDC`);
    console.log(`💸 Estimated gas: ${fmt(gasMatic,6)} MATIC ≈ ${fmt(gasUsdc,6)} USDC (gwei ${ethers.formatUnits(gasPrice,"gwei")}, gasEstimate ${gasEstimate})`);
    console.log(`🧮 Net profit after gas: ${fmt(netProfit,6)} USDC`);
    console.log(`🏦 Contract USDC balance (before): ${fmt(preBal,6)} USDC`);
    console.log(`⏳ Wallet MATIC balance: ${fmt(walletMatic,6)} MATIC`);

    // Safety checks
    if (preBal < MIN_CONTRACT_USDC_BUFFER) {
      console.warn(`⚠️ Skipping: Contract USDC buffer too low (< ${MIN_CONTRACT_USDC_BUFFER} USDC).`);
      return { sent: false, reason: "low_contract_buffer" };
    }
    if (netProfit < MIN_NET_PROFIT_USDC) {
      console.warn(`⚠️ Skipping: net profit ${fmt(netProfit,6)} USDC < MIN_NET_PROFIT_USDC (${MIN_NET_PROFIT_USDC})`);
      return { sent: false, reason: "low_net_profit" };
    }
    if (walletMatic < (gasMatic * 1.1)) {
      console.warn(`⚠️ Skipping: wallet MATIC (${fmt(walletMatic,6)}) < estimated needed (${fmt(gasMatic*1.1,6)})`);
      return { sent: false, reason: "low_wallet_matic" };
    }

    // callStatic to simulate
    try {
      await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenObj.address, parsedAmt, { gasLimit: gasEstimate * 2n });
    } catch (simErr) {
      console.warn(`⚠️ callStatic simulation reverted — skipping. reason: ${simErr.reason || simErr.message}`);
      return { sent: false, reason: "callStatic_reverted", simErr };
    }

    // send tx
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenObj.address, parsedAmt, { gasLimit: gasEstimate * 2n });
    console.log(`⏳ Trade tx sent: ${tx.hash} — waiting for confirmation...`);
    const receipt = await tx.wait();
    console.log(`✅ Tx mined in block ${receipt.blockNumber} | gasUsed: ${receipt.gasUsed.toString()}`);

    // post balances
    const postBalBN = await usdcContract.balanceOf(CONTRACT_ADDRESS);
    const postBal = Number(ethers.formatUnits(postBalBN, 6));
    const profitToContract = postBal - preBal;

    console.log(`🏦 Contract USDC balance (after): ${fmt(postBal,6)} USDC`);
    console.log(`💹 Net USDC change for contract this tx: ${fmt(profitToContract,6)} USDC`);
    console.log("------------------------------------------------------------\n");
    return { sent: true, receipt, profitToContract, gasUsdc };
  } catch (err) {
    console.error(`⚠️ Transaction failed or reverted: ${err.reason || err.message}`);
    return { sent: false, reason: "tx_error", err };
  }
}

// ─────────────── Main scan loop (40s) ───────────────
async function scanOnce() {
  console.log("🔍 Scanning for arbitrage opportunities...");
  const opportunities = [];
  for (const [symbol, tokenObj] of Object.entries(tokens)) {
    for (const [buyLabel, buyRouter] of Object.entries(routers)) {
      for (const [sellLabel, sellRouter] of Object.entries(routers)) {
        if (buyLabel === sellLabel) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, tokenObj, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, tokenObj, TRADE_AMOUNT_USDC);
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT/100);
          const profitPct = (profitUSDC / buyPrice) * 100;
          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(`\n🚨 ${symbol} | Buy:${buyLabel} @ $${fmt(buyPrice,6)} → Sell:${sellLabel} @ $${fmt(sellPrice,6)} | Estimated profit: ${fmt(profitUSDC,6)} USDC (${fmt(profitPct,2)}%)`);
            await executeTrade(buyRouter, sellRouter, tokenObj, TRADE_AMOUNT_USDC);
          }
        } catch (e) {
          console.warn(`⚠️ Error scanning ${symbol} ${buyLabel}->${sellLabel}: ${e.message}`);
        }
      }
    }
  }
  console.log("🔍 Scan pass finished.\n");
}

// start
(async () => {
  try {
    console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
    // quick connection check (owner & contract address)
    try {
      console.log("✅ Connected to contract:", arbContract.target || CONTRACT_ADDRESS);
      if (arbContract.owner) console.log("👤 Contract owner:", await arbContract.owner());
    } catch (e) {
      console.warn("⚠️ Warning reading contract owner:", e.message);
    }
    while (true) {
      await scanOnce();
      await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
    }
  } catch (e) {
    console.error("Fatal error:", e);
    process.exit(1);
  }
})();

