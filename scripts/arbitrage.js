/* ============================================================
   ArbJS - Full example with explicit logs, fixes, and execution
   ============================================================ */

import { Wallet, JsonRpcProvider, Contract, utils } from "ethers";

// ---------------- CONFIG ----------------
const INTERVAL = 15000; // 15 seconds
const SLIPPAGE_BPS = 20;
const JS_MIN_PROFIT = 0.0001;
const TRADE_USDC = 0.3;

const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

// Wallet from environment
const wallet = {
  address: "0x9e63CDc3D66714f0FCe5B3347139E117a04A75b3",
  privateKey: process.env.PRIVATE_KEY
};

if (!wallet.privateKey || !/^0x[a-fA-F0-9]{64}$/.test(wallet.privateKey)) {
  console.error("❌ Invalid PRIVATE_KEY in environment");
  process.exit(1);
}

// ---------------- TOKENS ----------------
const TOKENS = [
  { sym: "CRV", addr: "0x172370d5cd63279efa6d502dab29171933a610af", dec: 18 },
  { sym: "LINK", addr: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec: 18 },
  { sym: "AXLUSDC", addr: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", dec: 6 }
];

// ---------------- ABIS ----------------
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
];

const VAULT_ABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountInUSDC,uint256 minTokenOut,uint256 minUSDCOut,uint256 deadline) external"
];

// ---------------- PROVIDER & CONTRACTS ----------------
const provider = new JsonRpcProvider("https://polygon-rpc.com");
const signer = new Wallet(wallet.privateKey, provider);

const VAULT_CONTRACT = new Contract(VAULT, VAULT_ABI, signer);
const USDC_CONTRACT = new Contract(USDC, ERC20_ABI, signer);

// ---------------- DEXES ----------------
const DEXES = [
  { name: "ApeSwap", addr: "0xApeSwapRouter", router: new Contract("0xApeSwapRouter", ROUTER_ABI, provider) },
  { name: "SushiSwap", addr: "0xSushiRouter", router: new Contract("0xSushiRouter", ROUTER_ABI, provider) },
  { name: "QuickSwap", addr: "0xQuickRouter", router: new Contract("0xQuickRouter", ROUTER_ABI, provider) }
];

// ---------------- HELPERS ----------------
function toUSDC(v) {
  try { return Number(utils.formatUnits(v, 6)); }
  catch { return NaN; }
}

function toToken(v, dec) {
  try { return Number(utils.formatUnits(v, dec)); }
  catch { return NaN; }
}

function usdcAmount(amount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) throw new Error("Invalid USDC amount");
  return utils.parseUnits(a.toFixed(6), 6);
}

function safeParseAmount(value, dec) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error("Non-finite value");
  return utils.parseUnits(v.toFixed(6), dec);
}

// ---------------- STATE ----------------
let EXECUTING = false;

// ---------------- DISPLAY BALANCES ----------------
async function displayBalances() {
  try {
    const nativeBal = await provider.getBalance(wallet.address);
    const nativeEth = utils.formatEther(nativeBal);
    const walletUSDCBalRaw = await USDC_CONTRACT.balanceOf(wallet.address);
    const walletUSDCBal = toUSDC(walletUSDCBalRaw);
    const vaultUSDCBalRaw = await USDC_CONTRACT.balanceOf(VAULT);
    const vaultUSDCBal = toUSDC(vaultUSDCBalRaw);

    console.log(`💠 Wallet MATIC balance: ${Number(nativeEth).toFixed(6)} MATIC`);
    console.log(`💠 Wallet USDC balance: ${walletUSDCBal.toFixed(6)} USDC`);
    console.log(`💠 Vault USDC balance: ${vaultUSDCBal.toFixed(6)} USDC`);
  } catch (e) {
    console.error("❌ BALANCE FETCH ERROR:", e?.message ?? e);
  }
}

// ---------------- CORE SCAN / TRADE ----------------
async function scan() {
  if (EXECUTING) return;
  EXECUTING = true;

  try {
    await displayBalances();
    const vaultBal = toUSDC(await USDC_CONTRACT.balanceOf(VAULT));
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
            console.error(`⚠️ BUY FAILED ${t.sym} ${buy.name}:`, e?.message ?? e);
            continue;
          }

          const tokenRaw = buyOut?.[buyOut.length - 1];
          const tokenVal = toToken(tokenRaw, t.dec);
          if (!Number.isFinite(tokenVal) || tokenVal < 1e-6) continue;

          // SELL LEG
          let sellOut;
          try {
            sellOut = await sell.router.getAmountsOut(tokenRaw, [t.addr, USDC]);
          } catch (e) {
            console.error(`⚠️ SELL FAILED ${t.sym} ${sell.name}:`, e?.message ?? e);
            continue;
          }

          const usdcOutRaw = sellOut?.[sellOut.length - 1];
          const usdcOut = toUSDC(usdcOutRaw);
          const potentialProfit = usdcOut - TRADE_USDC;

          console.log(`[SIM] ${t.sym} ${buy.name}→${sell.name} | profit:${potentialProfit.toFixed(6)} | vault:${vaultBal.toFixed(4)}`);

          if (potentialProfit < JS_MIN_PROFIT) continue;

          const vaultBalNow = toUSDC(await USDC_CONTRACT.balanceOf(VAULT));
          if (vaultBalNow < TRADE_USDC) continue;

          const deadline = Math.floor(Date.now() / 1000) + 120;
          const minTokenOut = utils.parseUnits(tokenVal.toFixed(t.dec), t.dec);
          const minUSDCOut = utils.parseUnits(usdcOut.toFixed(6), 6);

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

            const walletUSDCPost = toUSDC(await USDC_CONTRACT.balanceOf(wallet.address));
            const vaultUSDCPost = toUSDC(await USDC_CONTRACT.balanceOf(VAULT));
            console.log(`💠 Wallet USDC (post): ${walletUSDCPost.toFixed(6)} | Vault USDC (post): ${vaultUSDCPost.toFixed(6)}`);

            EXECUTING = false;
            return;
          } catch (e) {
            console.error("❌ EXECUTION FAILED:", e?.message ?? e);
            EXECUTING = false;
          }
        }
      }
    }
  } catch (e) {
    console.error("❌ SCAN LOOP ERROR:", e?.message ?? e);
    EXECUTING = false;
  }
}

// ---------------- MAIN LOOP ----------------
console.log("🚀 Arb bot live");
setInterval(scan, INTERVAL);
scan();
