import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const TRADE_USDC = 0.17;
const MIN_PROFIT = 0.00001;
const SLIPPAGE_BPS = 50; // 0.50%
const INTERVAL = 8000;
const DRY_RUN = false;

/* =====================================================
   DEX ROUTERS
===================================================== */

const DEXES = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "ApeSwap",   address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
];

/* =====================================================
   TOKENS (FIXED FORMAT)
===================================================== */

const TOKENS = [
  { symbol:"WBTC", address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals:8 },
  { symbol:"AAVE", address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals:18 },
  { symbol:"CRV",  address:"0x172370d5cd63279efa6d502dab29171933a610af", decimals:18 },
  { symbol:"LINK", address:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals:18 },
  { symbol:"UNI",  address:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals:18 }
];

/* =====================================================
   ABIS
===================================================== */

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const VAULT_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)"
];

/* =====================================================
   SETUP
===================================================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);
const usdc  = new ethers.Contract(USDC, ERC20_ABI, provider);

for (const d of DEXES) {
  d.router = new ethers.Contract(d.address, ROUTER_ABI, provider);
}

/* =====================================================
   HELPERS
===================================================== */

const to6 = v => Number(ethers.formatUnits(v, 6));
const from6 = v => ethers.parseUnits(v.toFixed(6), 6);

function log(s, ok=false) {
  console.log(ok ? `\x1b[32m${s}\x1b[0m` : s);
}

async function vaultBalance() {
  return to6(await usdc.balanceOf(VAULT));
}

async function walletMatic() {
  return Number(ethers.formatEther(await provider.getBalance(wallet.address)));
}

function pathsBuy(token) {
  return [[USDC, token], [USDC, WMATIC, token], [USDC, WETH, token]];
}
function pathsSell(token) {
  return [[token, USDC], [token, WMATIC, USDC], [token, WETH, USDC]];
}

function applySlippage(x) {
  return x * (1 - SLIPPAGE_BPS / 10_000);
}

/* =====================================================
   CORE SCAN
===================================================== */

async function scan() {
  const vaultUSDC = await vaultBalance();
  const maticBal  = await walletMatic();

  for (const token of TOKENS) {
    for (const buy of DEXES) {
      for (const sell of DEXES) {
        if (buy === sell) continue;

        try {
          let bestBuy = 0;
          let bestSell = 0;

          for (const p of pathsBuy(token.address)) {
            const out = await buy.router.getAmountsOut(from6(TRADE_USDC), p);
            bestBuy = Math.max(bestBuy, Number(out.at(-1)));
          }

          if (!bestBuy) continue;

          for (const p of pathsSell(token.address)) {
            const out = await sell.router.getAmountsOut(bestBuy, p);
            bestSell = Math.max(bestSell, to6(out.at(-1)));
          }

          const profit = bestSell - TRADE_USDC;

          log(
            `[SIM] ${token.symbol} ${buy.name}→${sell.name} | buy:${bestBuy.toFixed(6)} sell:${bestSell.toFixed(6)} profit:${profit.toFixed(6)} | vault:${vaultUSDC.toFixed(2)} USDC | matic:${maticBal.toFixed(3)}`
          );

          if (profit < MIN_PROFIT) continue;

          log(`✔ SIM PASSED → ${token.symbol} PROFIT ${profit.toFixed(6)} USDC`, true);

          if (DRY_RUN) return;

          const minTokenOut = Math.floor(applySlippage(bestBuy));
          const minUSDCOut  = from6(applySlippage(bestSell));

          await vault.executeArbitrage(
            buy.address,
            sell.address,
            token.address,
            from6(TRADE_USDC),
            minTokenOut,
            minUSDCOut,
            from6(MIN_PROFIT)
          );

          return;
        } catch {}
      }
    }
  }
}

/* =====================================================
   LOOP
===================================================== */

log("🚀 Arb bot started");

setInterval(() => {
  scan().catch(() => {});
}, INTERVAL);
