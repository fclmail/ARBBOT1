import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT_ADDRESS = "0x2dD5820519aBbC74DB5658744e9EbAf9ED88320e";

const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const TRADE_AMOUNT_USDC = 0.17;
const MIN_PROFIT_USDC  = 0.00001;     // matches vault MIN_PROFIT
const SLIPPAGE_BUFFER  = 5;            // %
const SCAN_INTERVAL_MS = 8000;
const DRY_RUN = false;

/* =====================================================
   DEXES
===================================================== */

const DEXES = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "ApeSwap",   address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
];

const TOKENS = [
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  { symbol: "CRV",  address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 }
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

const ARB_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256) external",
  "event ArbitrageExecuted(address,address,address,address,uint256,uint256)"
];

/* =====================================================
   SETUP
===================================================== */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

const arb  = new ethers.Contract(VAULT_ADDRESS, ARB_ABI, wallet);
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);

for (const d of DEXES) {
  d.router = new ethers.Contract(d.address, ROUTER_ABI, provider);
}

let EXECUTING = false;

/* =====================================================
   HELPERS
===================================================== */

function log(msg, ok = false) {
  console.log(ok ? `\x1b[32m${msg}\x1b[0m` : msg);
}

async function vaultUSDC() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
}

async function walletMATIC() {
  return Number(ethers.formatEther(await provider.getBalance(wallet.address)));
}

function buyPaths(token) {
  return [
    [USDC, token],
    [USDC, WMATIC, token],
    [USDC, WETH, token]
  ];
}

function sellPaths(token) {
  return [
    [token, USDC],
    [token, WMATIC, USDC],
    [token, WETH, USDC]
  ];
}

/* =====================================================
   EXECUTION
===================================================== */

async function execute(best) {
  if (EXECUTING) return;
  EXECUTING = true;

  try {
    const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
    const deadline = Math.floor(Date.now() / 1000) + 60;

    // Static call safety check
    await arb.executeArbitrage.staticCall(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      best.minTokenOut,
      best.minUSDCOut,
      deadline
    );

    log("🟢 Simulation OK", true);
    if (DRY_RUN) return;

    const gas = await arb.executeArbitrage.estimateGas(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      best.minTokenOut,
      best.minUSDCOut,
      deadline
    );

    const tx = await arb.executeArbitrage(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      best.minTokenOut,
      best.minUSDCOut,
      deadline,
      { gasLimit: gas * 120n / 100n }
    );

    log(`🚀 TX SENT ${tx.hash}`, true);
    await tx.wait();

  } catch {
    log("❌ EXECUTION SKIPPED (slippage / MEV / fees)");
  } finally {
    EXECUTING = false;
  }
}

/* =====================================================
   SCANNER
===================================================== */

async function scan(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
  let best = null;

  for (const buy of DEXES) {
    for (const sell of DEXES) {
      if (buy === sell) continue;

      for (const bp of buyPaths(token.address)) {
        let bought;
        try {
          bought = (await buy.router.getAmountsOut(amountIn, bp)).at(-1);
        } catch { continue; }

        const minTokenOut =
          bought * BigInt(100 - SLIPPAGE_BUFFER) / 100n;

        for (const sp of sellPaths(token.address)) {
          let sold;
          try {
            sold = (await sell.router.getAmountsOut(bought, sp)).at(-1);
          } catch { continue; }

          const minUSDCOut =
            sold * BigInt(100 - SLIPPAGE_BUFFER) / 100n;

          const sellUSDC = Number(ethers.formatUnits(sold, 6));
          const profit = sellUSDC - TRADE_AMOUNT_USDC;

          log(
            `${token.symbol} ${buy.name}→${sell.name} | Profit ${profit.toFixed(6)}`,
            profit > 0
          );

          if (profit > MIN_PROFIT_USDC) {
            if (!best || profit > best.profit) {
              best = {
                token,
                buy,
                sell,
                profit,
                minTokenOut,
                minUSDCOut
              };
            }
          }
        }
      }
    }
  }

  if (best) {
    log(`💰 BEST ${best.token.symbol} PROFIT ${best.profit.toFixed(6)}`, true);
    await execute(best);
  }
}

/* =====================================================
   MAIN LOOP
===================================================== */

async function main() {
  log("⏱ ARB BOT STARTED");
  while (true) {
    try {
      log(`🏦 Vault USDC: ${await vaultUSDC()}`);
      log(`⛽ Wallet MATIC: ${await walletMATIC()}`);
      for (const t of TOKENS) {
        await scan(t);
      }
    } catch (e) {
      log(`❌ ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
