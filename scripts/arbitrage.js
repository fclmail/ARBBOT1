// arb.js — safe, on-chain-capable arbitrage runner (ethers v6)
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // hardcoded

console.log("PRIVATE_KEY:", PRIVATE_KEY ? "[OK]" : "[MISSING]");
console.log("CONTRACT_ADDRESS:", CONTRACT_ADDRESS ? "[OK]" : "[MISSING]");

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  throw new Error("❌ Missing PRIVATE_KEY or CONTRACT_ADDRESS");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ─────────────── SAFE HELPERS ───────────────
function safeGetAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  try { return ethers.getAddress(addr); }
  catch { 
    console.warn(`⚠️ Address failed checksum: ${addr} — using raw string where needed.`);
    // return null to indicate invalid if you prefer to skip; here we return raw to allow fallback
    return addr;
  }
}

async function ensureContractExists(addr) {
  try {
    const code = await provider.getCode(addr);
    return code && code !== "0x";
  } catch {
    return false;
  }
}

// ─────────────── CONTRACT (tolerant) ───────────────
let checkedContractAddress = safeGetAddress(CONTRACT_ADDRESS) || CONTRACT_ADDRESS;
(async () => {
  const exists = await ensureContractExists(checkedContractAddress);
  if (!exists) {
    console.warn(`⚠️ No contract code found at ${checkedContractAddress}. Continuing but calls will likely fail.`);
  }
})();

const arbAbi = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external",
  "function USDC() view returns(address)"
];

const arbContract = new ethers.Contract(checkedContractAddress, arbAbi, wallet);

// ─────────────── ROUTERS ───────────────
const routerAddresses = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routers = {};
for (const [k, v] of Object.entries(routerAddresses)) {
  const a = safeGetAddress(v);
  if (a) routers[k] = a;
  else console.warn(`⚠️ Router ${k} invalid, skipping: ${v}`);
}

// ─────────────── TOKENS ───────────────
// note: keep USDC correct (6 decimals) and used for parseUnits in getAmountOut / execute
const tokenList = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:  { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  MATICX:{ address: "0xa3fa99a148fa48d14ed51d610c367c61876997f1", decimals: 18 },
  QUICK:{ address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  UNI:  { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals: 18 },
  USDC: { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals: 6 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 }
};

const tokens = {};
for (const [s, t] of Object.entries(tokenList)) {
  const a = safeGetAddress(t.address);
  if (a) tokens[s] = { address: a, decimals: t.decimals };
  else console.warn(`⚠️ Token ${s} invalid, skipping: ${t.address}`);
}

// ─────────────── SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 10;
const MIN_PROFIT_PCT = 3;
const SLIPPAGE_PCT = 0;

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) { return Number(n).toFixed(dec); }

async function getAmountOut(routerAddr, token, amountIn) {
  if (!routerAddr || !token || !token.address) return 0;
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const path = [tokens.USDC.address, token.address];
  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    // last entry
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch (e) {
    // fallback via WETH
    try {
      const path2 = [tokens.USDC.address, tokens.WETH.address, token.address];
      const amounts = await router.getAmountsOut(
        ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
        path2
      );
      return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
    } catch {
      return 0;
    }
  }
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  // protect against bad addresses
  if (!buyRouter || !sellRouter || !tokenAddr) {
    console.warn("⚠️ executeTrade called with invalid addresses — skipping.");
    return;
  }

  try {
    const usdcAddress = await arbContract.USDC();
    const usdcContract = new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);

    const beforeBalBN = await usdcContract.balanceOf(checkedContractAddress);
    const beforeBal = Number(ethers.formatUnits(beforeBalBN, tokens.USDC.decimals));

    // simulate first
    try {
      await arbContract.callStatic.executeArbitrage(
        buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), tokens.USDC.decimals)
      );
    } catch (simErr) {
      console.warn("⚠️ callStatic simulation reverted — skipping execution. reason:", simErr.message);
      return;
    }

    // send tx
    const tx = await arbContract.executeArbitrage(
      buyRouter, sellRouter, tokenAddr, ethers.parseUnits(amount.toString(), tokens.USDC.decimals),
      { gasLimit: 2_000_000 }
    );

    console.log(`⏳ Trade sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      console.warn("⚠️ Transaction failed (status != 1).");
      return;
    }

    const afterBalBN = await usdcContract.balanceOf(checkedContractAddress);
    const afterBal = Number(ethers.formatUnits(afterBalBN, tokens.USDC.decimals));
    const profit = afterBal - beforeBal;

    console.log(`✅ Trade succeeded! 💰 Profit this trade: ${fmt(profit)} USDC | New balance: ${fmt(afterBal)} USDC`);
  } catch (err) {
    console.error(`⚠️ Trade failed or reverted: ${err.message}`);
  }
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Starting arbitrage scan...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    if (!token || !token.address) continue;

    for (const [buyName, buyRouter] of Object.entries(routers)) {
      if (!buyRouter) continue;
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (!sellRouter || buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          if (!buyOut || !sellOut) continue;

          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

          if (profitPct >= MIN_PROFIT_PCT) {
            opportunities.push({ token: symbol, buyName, sellName, buyPrice, sellPrice, profitUSDC, profitPct });
            console.log(`🚨 ${symbol} | Buy:${buyName} @ $${fmt(buyPrice)} → Sell:${sellName} @ $${fmt(sellPrice)} | Profit: $${fmt(profitUSDC)} (${fmt(profitPct,2)}%)`);

            // normalized addresses passed to executeTrade (these are checksummed/raw as returned earlier)
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }

        } catch (e) {
          console.warn(`⚠️ Error ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`🔍 Scan complete. Found ${opportunities.length} opportunities.\n`);
  return opportunities;
}

// ─────────────── MAIN LOOP ───────────────
async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error("Fatal error in scan():", e);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(console.error);

