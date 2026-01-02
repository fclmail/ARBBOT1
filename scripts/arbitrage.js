import { ethers } from "ethers";

/* =====================================================
   CONFIG
===================================================== */

const RPC_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ADDRESSES (REPLACE THESE 3)
const CONTRACT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const TOKEN_ADDRESS = "0x172370d5cd63279efa6d502dab29171933a610af";

// STABLES / BASES
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH   = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// ROUTERS
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// ADDITIONAL DEX ROUTERS (easy extension)
const ADDITIONAL_DEX1_ROUTER = "0x0000000000000000000000000000000000000000"; // replace with real address
const ADDITIONAL_DEX2_ROUTER = "0x0000000000000000000000000000000000000000"; // replace with real address

// TOKENS (you can add more here easily)
const TOKEN_A = TOKEN_ADDRESS; // existing primary token
const TOKEN_B = "0x1111111111111111111111111111111111111111"; // placeholder - replace
const TOKEN_C = "0x2222222222222222222222222222222222222222"; // placeholder - replace
// You can add more tokens below; the config is designed to be easily extended

/**** Dynamic list of ERC20s to arbitrage against (example) ****/
const ERC20_TOKENS = [
  { symbol: "TOKEN_A", address: TOKEN_A },
  { symbol: "TOKEN_B", address: TOKEN_B },
  { symbol: "TOKEN_C", address: TOKEN_C }
];
// BOT SETTINGS
const SCAN_INTERVAL_MS = 5000;
const TRADE_AMOUNT_USDC = 0.1;
const MIN_PROFIT_USDC = 0.001; // on-chain min profit enforcement
const DRY_RUN = true; // default dry-run behavior; see vault balance logic below

// Vault balance threshold logic for dry-run
const VAULT_BALANCE_THRESHOLD_USDC = 0.02; // if vault balance is very small, auto-disable dry-run for safety

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
  "function executeArbitrage(uint256 amount) external"
];

/* =====================================================
   SETUP
===================================================== */

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY missing");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("✅ Wallet loaded:", wallet.address);

const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
const quickswap = new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, provider);
const sushiswap = new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, provider);

// Additional routers (optional)
const dex1 = new ethers.Contract(ADDITIONAL_DEX1_ROUTER, ROUTER_ABI, provider);
const dex2 = new ethers.Contract(ADDITIONAL_DEX2_ROUTER, ROUTER_ABI, provider);

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

/* =====================================================
   HELPERS
===================================================== */

async function getVaultBalance() {
  const bal = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(bal, 6));
}

/** Get quoted output amount for a given router and path */
async function getQuote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return 0n;
  }
}

/* =====================================================
   PATHS (easy extendable)
===================================================== */

// Base token order matters for path arrays
// Each entry corresponds to a buy path (USDC -> ...TOKEN)
// The corresponding SELL_PATHS entry should be the reverse-like path to USDC
const BUY_PATHS = [
  // existing
  [USDC_ADDRESS, TOKEN_A],
  [USDC_ADDRESS, WMATIC, TOKEN_A],
  [USDC_ADDRESS, WETH, TOKEN_A],
  [USDC_ADDRESS, WMATIC, WETH, TOKEN_A],
  // new tokens (extend by duplicating with new tokens)
  [USDC_ADDRESS, TOKEN_B],
  [USDC_ADDRESS, WMATIC, TOKEN_B],
  [USDC_ADDRESS, WETH, TOKEN_B],
  [USDC_ADDRESS, WMATIC, WETH, TOKEN_B],
  [USDC_ADDRESS, TOKEN_C],
  [USDC_ADDRESS, WMATIC, TOKEN_C],
  [USDC_ADDRESS, WETH, TOKEN_C],
  [USDC_ADDRESS, WMATIC, WETH, TOKEN_C]
];

// Sell paths corresponding to each buy path above (TOKEN -> USDC, possibly multi-hop)
const SELL_PATHS = [
  // corresponding to TOKEN_A
  [TOKEN_A, USDC_ADDRESS],
  [TOKEN_A, WMATIC, USDC_ADDRESS],
  [TOKEN_A, WETH, USDC_ADDRESS],
  [TOKEN_A, WETH, WMATIC, USDC_ADDRESS],
  // TOKEN_B
  [TOKEN_B, USDC_ADDRESS],
  [TOKEN_B, WMATIC, USDC_ADDRESS],
  [TOKEN_B, WETH, USDC_ADDRESS],
  [TOKEN_B, WMATIC, WETH, USDC_ADDRESS],
  // TOKEN_C
  [TOKEN_C, USDC_ADDRESS],
  [TOKEN_C, WMATIC, USDC_ADDRESS],
  [TOKEN_C, WETH, USDC_ADDRESS],
  [TOKEN_C, WMATIC, WETH, USDC_ADDRESS]
];

/* In-case you want to use additional dexes for different paths, you can extend:
   const ADDITIONAL_BUY_PATHS = [
     [USDC_ADDRESS, TOKEN_A], // etc
   ];
   and map SELL_PATHS accordingly.
*/

/* =====================================================
   TWO-DEX ARBITRAGE (ALL PATHS)
===================================================== */

async function calculateSide(routerBuy, routerSell, amountUSDC) {
  const amountIn = ethers.parseUnits(amountUSDC.toString(), 6);

  let best = {
    buyTokens: 0n,
    sellUSDC: 0n,
    profit: -Infinity,
    pathIndex: -1
  };

  // Iterate through all defined paths
  for (let i = 0; i < BUY_PATHS.length; i++) {
    const buyPath = BUY_PATHS[i];
    const sellPath = SELL_PATHS[i];

    // Parallel quotes: buy amount and then sell amount based on buy
    const [buy, sell] = await (async () => {
      try {
        const b = await getQuote(routerBuy, amountIn, buyPath);
        if (b === 0n) return [0n, 0n];
        const s = await getQuote(routerSell, b, sellPath);
        return [b, s];
      } catch {
        return [0n, 0n];
      }
    })();

    if (buy === 0n || sell === 0n) continue;

    // Profit in USDC (6 decimals)
    const profit = Number(ethers.formatUnits(sell, 6)) - amountUSDC;
    if (profit > best.profit) {
      best = { buyTokens: buy, sellUSDC: sell, profit, pathIndex: i };
    }
  }

  return best;
}

/* =====================================================
   LAUNCH LOGIC: PROFITABILITY CHECKS WITH ACTUAL COSTS
===================================================== */

async function estimateGasCostUSDC() {
  // rough gas cost estimation; improve with real gas price if you want
  try {
    const gasPrice = await provider.getGasPrice();
    // rough gas limit; adjust if you know your tx size
    const GAS_LIMIT = 250000;
    const gasCostWei = gasPrice.mul(GAS_LIMIT);
    // 1 USDC has 1e6 units, convert wei -> USDC units
    // We assume 1e18 for ETH-like units; since USDC is 6 decimals,
    // convert by dividing by 1e12 to get USDC units
    const gasCostUSDC = Number(ethers.formatUnits(gasCostWei, 18)) / 1e12;
    return gasCostUSDC;
  } catch {
    return 0;
  }
}

/* =====================================================
   LOOP
===================================================== */

async function attemptArbitrage() {
  console.log(`🏦 Vault USDC: ${await getVaultBalance()}`);
  console.log(`🏦 Wallet MATIC: ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
  console.log("🔎 Attempting arbitrage...");

  // Parallelize across both directions
  const [quickToSushi, sushiToQuick] = await Promise.all([
    calculateSide(quickswap, sushiswap, TRADE_AMOUNT_USDC),
    calculateSide(sushiswap, quickswap, TRADE_AMOUNT_USDC)
  ]);

  // Expanded logs for all paths
  function logPath(label, data) {
    if (!data || data.pathIndex === -1) {
      console.log(`  ${label}: no profitable path found`);
      return;
    }
  }

  console.log("🔁 QUICK → SUSHI");
  if (quickToSushi.pathIndex >= 0) {
    console.log(`💰 Buy:  ${TRADE_AMOUNT_USDC} USDC → ${quickToSushi.buyTokens}`);
    console.log(`💵 Sell: ${quickToSushi.buyTokens} → ${ethers.formatUnits(quickToSushi.sellUSDC, 6)} USDC`);
    console.log(`💸 Profit: ${quickToSushi.profit} USDC (path #${quickToSushi.pathIndex})`);
  } else {
    console.log("  No profitable QUICK→SUSHI path found.");
  }





/* =====================================================
   CONTINUATION: ARB SCRIPT LOGIC AND OUTPUT HANDLING
===================================================== */

// Continue the logs for the QUICK → SUSHI path
  if (quickToSushi.pathIndex >= 0) {
    console.log(`💰 Buy:  ${TRADE_AMOUNT_USDC} USDC → ${quickToSushi.buyTokens}`);
    console.log(`💵 Sell: ${quickToSushi.buyTokens} → ${ethers.formatUnits(quickToSushi.sellUSDC, 6)} USDC`);
    console.log(`💸 Profit: ${quickToSushi.profit} USDC (path #${quickToSushi.pathIndex})`);
  } else {
    console.log("  No profitable QUICK→SUSHI path found.");
  }

  console.log("🔁 SUSHI → QUICK");
  if (sushiToQuick.pathIndex >= 0) {
    console.log(`💰 Buy:  ${TRADE_AMOUNT_USDC} USDC → ${sushiToQuick.buyTokens}`);
    console.log(`💵 Sell: ${sushiToQuick.buyTokens} → ${ethers.formatUnits(sushiToQuick.sellUSDC, 6)} USDC`);
    console.log(`💸 Profit: ${sushiToQuick.profit} USDC (path #${sushiToQuick.pathIndex})`);
  } else {
    console.log("  No profitable SUSHI→QUICK path found.");
  }

  // Check if there is any profitable opportunity considering min profit
  const hasProfit =
    (quickToSushi.pathIndex >= 0 && quickToSushi.profit >= MIN_PROFIT_USDC) ||
    (sushiToQuick.pathIndex >= 0 && sushiToQuick.profit >= MIN_PROFIT_USDC);

  if (!hasProfit) {
    console.log("❌ No profitable opportunity (below min profit or no viable path)");
    // Optionally, implement a backoff or extend scan window
    return;
  }

  // Decide best direction by profit
  const best =
    quickToSushi.profit > sushiToQuick.profit
      ? { dir: "QUICK → SUSHI", data: quickToSushi }
      : { dir: "SUSHI → QUICK", data: sushiToQuick };

  console.log(`📈 PROFITABLE DIRECTION: ${best.dir}`);
  console.log(`🛣 Path index used: ${best.data.pathIndex}`);

  // Dry-run toggle with vault-balance awareness
  // If DRY_RUN is true, we won't execute. If false, attempt a real tx.
  // Additionally, if the TRADE_AMOUNT_USDC is larger than the vault balance and DRY_RUN is true,
  // we allow a "live-like" dry-run by simulating with vault balance guardrails.
  const vaultBalance = await getVaultBalance();
  const canRunLive = !DRY_RUN && TRADE_AMOUNT_USDC <= vaultBalance;

  // If DRY_RUN is true but you want to test larger amounts safely, here's a vault-balance aware toggle:
  const allowDryRunSmall = DRY_RUN && TRADE_AMOUNT_USDC <= vaultBalance;
  const allowDryRunLarge = DRY_RUN && TRADE_AMOUNT_USDC > vaultBalance && vaultBalance > 0;

  if (canRunLive) {
    // Live execution path
    console.log("💠 Executing arbitrage on-chain (live)...");
    await arbContract.executeArbitrage(
      ethers.parseUnits(best.data ? best.data.amountToTrade?.toString?.() || TRADE_AMOUNT_USDC.toString() : TRADE_AMOUNT_USDC.toString(), 6)
    );
  } else if (allowDryRunSmall) {
    // Dry-run small amount within vault
  } else if (allowDryRunLarge) {
    // Large trade but still in DRY_RUN mode: simulate and log without sending tx
    console.log("⚠️ DRY_RUN with vault-insufficient trade size: simulating (no tx) for larger amount.");
    // We can simulate by emitting logs only; no blockchain interaction
    console.log(`Simulated: Direction ${best.dir}, amount USDC: ${TRADE_AMOUNT_USDC}`);
    console.log(`Path index: ${best.data.pathIndex}`);
    console.log("NOTE: No on-chain tx executed due to vault balance limitations in DRY_RUN mode.");
    return;
  } else {
    // DRY_RUN is false but we couldn't compute a safe live path (e.g., not profitable after min profit)
    console.log("❌ Live execution disabled or no profitable path satisfying min profit and risk checks.");
    return;
  }
}

/* =====================================================
   MAIN
===================================================== */

async function main() {
  console.log("⏱ Polygon Arb Bot Started (multi-dex, multi-token)");

  // Warm-up: maybe pre-fetch some quotes or balances if needed
  // Optional: ensure vault has some USDC allowance by user side if you do approve flow.

  while (true) {
    try {
      await attemptArbitrage();
    } catch (err) {
      console.error("❌ Loop error:", err?.message ?? err);
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

main();
