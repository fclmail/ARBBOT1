/* ============================================================
   ArbJS – FULL, SYNTACTICALLY COMPLETE VERSION (CommonJS)
   ============================================================ */

const { ethers } = require("ethers");

/* ===================== CONFIG ===================== */

const INTERVAL = 15000;          // 15s
const SLIPPAGE_BPS = 20;         // 0.20%
const JS_MIN_PROFIT = 0.01;      // 0.01 USDC
const TRADE_USDC = 0.5;

const RPC = "https://polygon-rpc.com";

const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const wallet = {
  address: "0xYOUR_WALLET",
  privateKey: "0xYOUR_PRIVATE_KEY"
};

/* ===================== TOKENS ===================== */

const TOKENS = [
  { sym:"CRV",  addr:"0x172370d5cd63279efa6d502dab29171933a610af", dec:18 },
  { sym:"LINK", addr:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", dec:18 },
  { sym:"AAVE", addr:"0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", dec:18 }
];

/* ===================== ABIs ===================== */

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[])"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const VAULT_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256) external"
];

/* ===================== PROVIDER ===================== */

const provider = new ethers.providers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(wallet.privateKey, provider);

const USDC_CONTRACT = new ethers.Contract(USDC, ERC20_ABI, provider);
const VAULT_CONTRACT = new ethers.Contract(VAULT, VAULT_ABI, signer);

/* ===================== DEX ROUTERS ===================== */

const DEXES = [
  { name:"QuickSwap", addr:"0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name:"SushiSwap", addr:"0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name:"ApeSwap",   addr:"0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
].map(d => ({
  ...d,
  router: new ethers.Contract(d.addr, ROUTER_ABI, provider)
}));

/* ===================== HELPERS ===================== */

const toUSDC = v => Number(ethers.utils.formatUnits(v, 6));
const toToken = (v, d) => Number(ethers.utils.formatUnits(v, d));
const usdc = v => ethers.utils.parseUnits(v.toFixed(6), 6);

let EXECUTING = false;

/* ===================== BALANCES ===================== */

async function showBalances() {
  const vaultBal = toUSDC(await USDC_CONTRACT.balanceOf(VAULT));
  console.log(`💰 Vault USDC: ${vaultBal.toFixed(6)}`);
}

/* ===================== CORE SCAN ===================== */

async function scan() {
  if (EXECUTING) return;
  EXECUTING = true;

  try {
    await showBalances();

    const vaultBal = toUSDC(await USDC_CONTRACT.balanceOf(VAULT));
    if (vaultBal < TRADE_USDC) {
      EXECUTING = false;
      return;
    }

    for (const t of TOKENS) {
      for (const buy of DEXES) {
        for (const sell of DEXES) {
          if (buy.addr === sell.addr) continue;

          let buyOut;
          try {
            buyOut = await buy.router.getAmountsOut(
              usdc(TRADE_USDC),
              [USDC, t.addr]
            );
          } catch {
            continue;
          }

          const tokenRaw = buyOut[1];
          const tokenAmt = toToken(tokenRaw, t.dec);
          if (tokenAmt <= 0) continue;

          let sellOut;
          try {
            sellOut = await sell.router.getAmountsOut(
              tokenRaw,
              [t.addr, USDC]
            );
          } catch {
            continue;
          }

          const usdcOut = toUSDC(sellOut[1]);
          const profit = usdcOut - TRADE_USDC;

          console.log(
            `[SIM] ${t.sym} ${buy.name}→${sell.name} | buy:${tokenAmt.toFixed(6)} sell:${usdcOut.toFixed(6)} profit:${profit.toFixed(6)}`
          );

          if (profit < JS_MIN_PROFIT) continue;

          const deadline = Math.floor(Date.now() / 1000) + 120;
          const minTokenOut = tokenRaw.mul(10000 - SLIPPAGE_BPS).div(10000);
          const minUSDCOut = sellOut[1].mul(10000 - SLIPPAGE_BPS).div(10000);

          console.log("🟢 EXECUTING");

          try {
            const tx = await VAULT_CONTRACT.executeArbitrage(
              buy.addr,
              sell.addr,
              t.addr,
              usdc(TRADE_USDC),
              minTokenOut,
              minUSDCOut,
              deadline
            );

            console.log(`📤 TX SENT ${tx.hash}`);
            await tx.wait();
            console.log(`✅ TX CONFIRMED`);
            await showBalances();
            EXECUTING = false;
            return;

          } catch (e) {
            console.error("❌ EXEC FAIL:", e.reason || e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error("❌ SCAN ERROR:", e.message);
  }

  EXECUTING = false;
}

/* ===================== START ===================== */

console.log("🚀 Arb bot live");
setInterval(scan, INTERVAL);
