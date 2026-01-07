/* ============================================================
   ArbJS - Full example with explicit logs, fixes, and execution
   - Private key pulled from environment
   - ES module compatible
   - Includes: SIM results, profit display, execution path
   - Robust error handling for debugging
   ============================================================ */

// 1) IMPORTS
import { ethers } from "ethers";

// 2) CONFIGURATION AND GLOBALS (edit these for your environment)
const INTERVAL = 15000; // 15 seconds
const SLIPPAGE_BPS = 20; // baseline slippage basis points
const JS_MIN_PROFIT = 0.01; // minimum profit in USDC to execute
const TRADE_USDC = 0.5; // amount of USDC to use per trade (example)

// Vault and USDC
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // example
const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e"; // your vault contract

// Wallet address (hardcoded) and private key from environment
const wallet = {
  address: "0x9e63CDc3D66714f0FCe5B3347139E117a04A75b3",
  privateKey: process.env.PRIVATE_KEY
};

// Validate private key
if (!wallet.privateKey || !/^0x[a-fA-F0-9]{64}$/.test(wallet.privateKey)) {
  console.error("❌ Invalid or missing PRIVATE_KEY in environment");
  process.exit(1);
}

// Minimal token list
const TOKENS = [
  { sym: "CRV", addr: "0x172370d5cd63279efa6d502dab29171933a610af", dec: 18 },
  { sym: "LINK", addr: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec: 18 },
  { sym: "AXLUSDC", addr: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", dec: 6 }
];

// Simple router ABI for getAmountsOut
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"
];

// ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
];

// Vault ABI
const VAULT_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256) external"
];

// 3) PROVIDER AND CONTRACTS
const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com"); // change if needed
const signer = new ethers.Wallet(wallet.privateKey, provider);

const VAULT_CONTRACT = new ethers.Contract(VAULT, VAULT_ABI, signer);
const USDC_CONTRACT = new ethers.Contract(USDC, ERC20_ABI, signer);

// DEX routers placeholders (replace addresses)
const DEXES = [
  { name: "ApeSwap", addr: "0xApeSwapRouter", router: new ethers.Contract("0xApeSwapRouter", ROUTER_ABI, provider) },
  { name: "SushiSwap", addr: "0xSushiRouter", router: new ethers.Contract("0xSushiRouter", ROUTER_ABI, provider) },
  { name: "QuickSwap", addr: "0xQuickRouter", router: new ethers.Contract("0xQuickRouter", ROUTER_ABI, provider) }
];

// 4) HELPERS
function toUSDC(v) {
  try { return Number(ethers.utils.formatUnits(v, 6)); }
  catch { return NaN; }
}

function toToken(v, dec) {
  try { return Number(ethers.utils.formatUnits(v, dec)); }
  catch { return NaN; }
}

function usdcAmount(amount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) throw new Error("Invalid USDC amount");
  return ethers.utils.parseUnits(a.toFixed(6), 6);
}

function safeParseAmount(value, dec) {
  try {
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error("Non-finite value");
    return ethers.utils.parseUnits(v.toFixed(6), dec);
  } catch (e) {
    console.error("⚠️ Failed to parse amount:", value, "error:", e?.message ?? e);
    throw e;
  }
}

// 5) STATE
let EXECUTING = false;

// Display wallet and vault balances
async function displayBalances() {
  try {
    const nativeBal = await provider.getBalance(wallet.address);
    const walletUSDCBalRaw = await USDC_CONTRACT.balanceOf(wallet.address);
    const vaultUSDCBalRaw = await USDC_CONTRACT.balanceOf(VAULT);

    console.log(`💠 Wallet MATIC balance: ${Number(ethers.utils.formatEther(nativeBal)).toFixed(6)} MATIC`);
    console.log(`💠 Wallet USDC balance: ${toUSDC(walletUSDCBalRaw).toFixed(6)} USDC`);
    console.log(`💠 Vault USDC balance: ${toUSDC(vaultUSDCBalRaw).toFixed(6)} USDC`);
  } catch (e) {
    console.error("❌ BALANCE FETCH ERROR:", e?.message ?? e);
  }
}

// 6) CORE SCAN/TRADE LOOP
async function scan() {
  if (EXECUTING) return;
  EXECUTING = true;

  try {
    await displayBalances();
    const vaultBalRaw = await USDC_CONTRACT.balanceOf(VAULT);
    const vaultBal = toUSDC(vaultBalRaw);
    console.log(`🔎 Vault available USDC: ${vaultBal.toFixed(6)} USDC`);

    for (const t of TOKENS) {
      if (!Number.isFinite(t.dec)) continue;

      for (const buy of DEXES) {
        for (const sell of DEXES) {
          if (buy.addr === sell.addr) continue;

          // BUY LEG
          let buyOut;
          try {
            buyOut = await buy.router.getAmountsOut(usdcAmount(TRADE_USDC), [USDC, t.addr]);
          } catch (e) {
            console.error(`⚠️ BUY GET AMOUNTS OUT FAILED for ${t.sym} ${buy.name}:`, e?.message ?? e);
            continue;
          }

          const tokenRaw = buyOut[buyOut.length - 1];
          const tokenVal = toToken(tokenRaw, t.dec);

          if (!Number.isFinite(tokenVal) || tokenVal < 1e-6) {
            console.log(`ℹ️ SKIP: ${t.sym} token received too small: ${tokenVal}`);
            continue;
          }

          // SELL LEG
          let sellOut;
          try {
            sellOut = await sell.router.getAmountsOut(tokenRaw, [t.addr, USDC]);
          } catch (e) {
            console.error(`⚠️ SELL GET AMOUNTS OUT FAILED for ${t.sym} ${sell.name}:`, e?.message ?? e);
            continue;
          }

          const usdcOut = toUSDC(sellOut[sellOut.length - 1]);
          const potentialProfit = usdcOut - TRADE_USDC;

          console.log(`[SIM] ${t.sym} ${buy.name}→${sell.name} | buy:${tokenVal.toFixed(6)} sell:${usdcOut.toFixed(6)} profit:${potentialProfit.toFixed(6)} | vault:${vaultBal.toFixed(4)}`);

          if (potentialProfit < JS_MIN_PROFIT) continue;
          const vaultBalNow = toUSDC(await USDC_CONTRACT.balanceOf(VAULT));
          if (vaultBalNow < TRADE_USDC) {
            console.log(`⚠️ SKIP: Vault insufficient USDC. Needed ${TRADE_USDC}, have ${vaultBalNow}`);
            continue;
          }

          const deadline = Math.floor(Date.now() / 1000) + 120;
          const minTokenOut = ethers.utils.parseUnits(tokenVal.toFixed(t.dec), t.dec);
          const minUSDCOut = ethers.utils.parseUnits(usdcOut.toFixed(6), 6);

          console.log(`🚀 EXECUTING: ${t.sym} ${buy.name}→${sell.name} with ${TRADE_USDC} USDC`);

          try {
            const tx = await VAULT_CONTRACT.executeArbitrage(
              buy.addr,
              sell.addr,
              t.addr,
              usdcAmount(TRADE_USDC),
              minTokenOut,
              minUSDCOut,
              deadline
            );
            console.log(`✅ TX SENT: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`✅ TX CONFIRMED in block ${receipt.blockNumber}`);

            // Post-ARB balances
            const walletUSDCBalRaw = await USDC_CONTRACT.balanceOf(wallet.address);
            const vaultBalPostRaw = await USDC_CONTRACT.balanceOf(VAULT);

            console.log(`💠 Wallet USDC balance (post-arb): ${toUSDC(walletUSDCBalRaw).toFixed(6)} USDC`);
            console.log(`💠 Vault USDC balance (post-arb): ${toUSDC(vaultBalPostRaw).toFixed(6)} USDC`);

            EXECUTING = false;
            return; // stop after first profitable execution
          } catch (execErr) {
            EXECUTING = false;
            console.error("❌ EXECUTION FAILED:", execErr?.reason ?? execErr?.message ?? execErr);
          }
        }
      }
    }
  } catch (err) {
    EXECUTING = false;
    console.error("❌ SCAN ERROR:", err?.message ?? err);
  }
}

// 7) START LOOP
console.log("🚀 Arb bot live");
setInterval(scan, INTERVAL);
