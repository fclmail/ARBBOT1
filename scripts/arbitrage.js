import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// CORE CONTRACTS
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS    = CONTRACT_ADDRESS;

// BASE TOKENS
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC       = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH         = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// DEX ROUTERS
const DEXES = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506" },
  { name: "Dfyn",      address: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73" },
  { name: "ApeSwap",   address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" }
];

// TOKENS
const ERC20_TOKENS = [
  { symbol: "CRV",  address: "0x172370d5cd63279efa6d502dab29171933a610af" },
  { symbol: "AAVE", address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" },
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" }
];

// BOT SETTINGS
const SCAN_INTERVAL_MS   = 8000;
const TRADE_AMOUNT_USDC = 2.16;
const MIN_PROFIT_USDC   = 0.000005;
const EST_GAS           = 0.0;
const MATIC_USDC_PRICE  = 0.0;
const DRY_RUN           = true;

/* =====================================================
   ABIs
===================================================== */

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)"
];

const ARB_ABI = [
  "function executeArbitrage(address,address,address,uint256,uint256) external",
  "event ArbitrageExecuted(address,address,address,address,uint256,uint256,uint256,uint256)"
];

/* =====================================================
   SETUP
===================================================== */

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY missing");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet loaded:", wallet.address);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
const arb  = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

for (const d of DEXES) {
  d.contract = new ethers.Contract(d.address, ROUTER_ABI, provider);
}

let EXECUTING = false;

/* =====================================================
   HELPERS
===================================================== */

function log(line, green = false) {
  process.stdout.write(
    green ? `\x1b[32m${line}\x1b[0m\n` : `${line}\n`
  );
}

async function vaultBalance() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
}

async function quote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return 0n;
  }
}

/* =====================================================
   PATH BUILDERS
===================================================== */

function buildBuyPaths(token) {
  return [
    [USDC_ADDRESS, token],
    [USDC_ADDRESS, WMATIC, token],
    [USDC_ADDRESS, WETH, token]
  ];
}

function buildSellPaths(token) {
  return [
    [token, USDC_ADDRESS],
    [token, WMATIC, USDC_ADDRESS],
    [token, WETH, USDC_ADDRESS]
  ];
}

/* =====================================================
   EXECUTION (SINGLE OPTIMAL ROUTE)
===================================================== */

async function execute(best) {
  if (EXECUTING) return;
  EXECUTING = true;

  try {
    const amountIn  = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);
    const minReturn = ethers.parseUnits(
      (TRADE_AMOUNT_USDC + best.profit).toFixed(6),
      6
    );

    // 🔒 simulate
    await arb.executeArbitrage.staticCall(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      minReturn
    );

    if (DRY_RUN) {
      log("🧪 DRY RUN – tx not sent", true);
      return;
    }

    const tx = await arb.executeArbitrage(
      best.buy.address,
      best.sell.address,
      best.token.address,
      amountIn,
      minReturn,
      { gasLimit: EST_GAS }
    );

    log(`🚀 TX SENT ${tx.hash}`, true);

    const receipt = await tx.wait();
    const iface = new ethers.Interface(ARB_ABI);

    for (const logItem of receipt.logs) {
      try {
        const parsed = iface.parseLog(logItem);
        if (parsed.name === "ArbitrageExecuted") {
          const profit = Number(parsed.args.profitUSDC) / 1e6;
          log(`🎉 ARBITRAGE CONFIRMED PROFIT ${profit.toFixed(6)} USDC`, true);
          log(`🏦 VAULT ${await vaultBalance()} USDC`, true);
        }
      } catch {}
    }

  } catch (e) {
    log(`❌ EXECUTION FAILED ${e.shortMessage || e.message}`);
  } finally {
    EXECUTING = false;
  }
}

/* =====================================================
   SCANNER (VERBOSE, USER FRIENDLY)
===================================================== */

async function scanToken(token) {
  const amountIn = ethers.parseUnits(TRADE_AMOUNT_USDC.toString(), 6);

  const feeData = await provider.getFeeData();
  if (!feeData.gasPrice) return;

  const gasCost =
    (Number(feeData.gasPrice) / 1e18) *
    EST_GAS *
    MATIC_USDC_PRICE;

  let best = null;

  for (const buy of DEXES) {
    for (const sell of DEXES) {
      if (buy === sell) continue;

      for (const buyPath of buildBuyPaths(token.address)) {
        const buyOut = await quote(buy.contract, amountIn, buyPath);
        if (!buyOut) continue;

        for (const sellPath of buildSellPaths(token.address)) {
          const sellOut = await quote(sell.contract, buyOut, sellPath);
          if (!sellOut) continue;

          const sellUSDC = Number(ethers.formatUnits(sellOut, 6));
          const profit   = sellUSDC - TRADE_AMOUNT_USDC;

          const line =
            `[${new Date().toISOString()}] ${token.symbol} ` +
            `BUY ${buy.name} ${TRADE_AMOUNT_USDC.toFixed(5)} → ` +
            `SELL ${sell.name} ${sellUSDC.toFixed(5)} | ` +
            `PROFIT ${profit.toFixed(6)} ${profit > 0 ? "✅" : "❌"}`;

          log(line, profit > 0);

          if (profit > MIN_PROFIT_USDC + gasCost) {
            if (!best || profit > best.profit) {
              best = { token, buy, sell, profit };
            }
          }
        }
      }
    }
  }

  if (best) {
    log(
      `💰 BEST ROUTE ${best.token.symbol} ` +
      `${best.buy.name} → ${best.sell.name} ` +
      `PROFIT ${best.profit.toFixed(6)} USDC`,
      true
    );
    await execute(best);
  }
}

/* =====================================================
   MAIN LOOP
===================================================== */

async function main() {
  log("⏱ Polygon Arbitrage Bot Started");

  while (true) {
    try {
      log(`🏦 Vault ${await vaultBalance()} USDC`);
      for (const token of ERC20_TOKENS) {
        await scanToken(token);
      }
    } catch (e) {
      log(`❌ ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
