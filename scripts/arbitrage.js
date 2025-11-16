// scripts/arbitrage.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/*
  FEATURES:
  - No callStatic used anywhere (removed)
  - Swap-revert flow: try real executeArbitrage (if DRY_RUN=false) and handle revert
  - Option 7: special dry-run mode that simulates swaps & accumulates profit
  - Decimal normalization: we simulate 1 USDC => token => USDC (round trip)
  - Robust: bad addresses don't crash the script; they are logged and skipped
  - Full logs & debug data on failures
*/

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // required for live mode
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43";
const DRY_RUN = true;     // true = never send txs; false = will attempt real executeArbitrage
const MODE = 7;           // your requested "option 7" behavior: special dry-run accumulation
const TRADE_AMOUNT_USDC = 1; // normalize to 1 USDC
const MIN_PROFIT_PCT = 0.5;  // minimum percent profit to attempt/record
const SLIPPAGE_PCT = 0;      // reduce expected profit by this percent for safety
const GAS_LIMIT = 2_000_000;

// ---------------- PROVIDER & WALLET ----------------
if (!DRY_RUN && !PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY required for live execution (DRY_RUN=false). Aborting.");
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;

// ---------------- ABI & CONTRACT ----------------
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
  { "inputs": [], "name": "USDC", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

const arbContract = wallet ? new ethers.Contract(CONTRACT_ADDRESS, arbAbi, wallet) : new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// ---------------- ROUTERS & TOKENS (as requested) ----------------
// NOTE: we attempt to normalize addresses safely (skip if invalid)
const ROUTER_CANDIDATES = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90F643E76D3F6E6Ff73",   // keep original; we'll validate
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const TOKEN_CANDIDATES = {
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  CRV:  "0x172370d5cd63279efa6d502dab29171933a610af",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

// Build validated maps: if an address is invalid, it will be skipped but the bot continues.
const routers = {};
for (const [name, addr] of Object.entries(ROUTER_CANDIDATES)) {
  try {
    routers[name] = ethers.getAddress(addr);
  } catch (e) {
    console.warn(`⚠️ Router address invalid/checksum failed for ${name}: ${addr} — skipping router`);
  }
}
const tokens = {};
for (const [symbol, addr] of Object.entries(TOKEN_CANDIDATES)) {
  try {
    // we'll also keep token decimals mapping below
    tokens[symbol] = { address: ethers.getAddress(addr), decimals: null };
  } catch (e) {
    console.warn(`⚠️ Token address invalid/checksum failed for ${symbol}: ${addr} — skipping token`);
  }
}

// ---------------- UTILITIES ----------------
function log(...args) { console.log(...args); }
function warn(...args) { console.warn(...args); }
function errlog(...args) { console.error(...args); }
function fmt(n, d = 6) { return Number(n).toFixed(d); }

// Safe read token decimals (ERC20) — sets tokens[..].decimals or defaults to 18
async function ensureTokenDecimals(tokenObj) {
  if (!tokenObj) return;
  if (tokenObj.decimals && typeof tokenObj.decimals === "number") return tokenObj.decimals;
  try {
    const erc20 = new ethers.Contract(tokenObj.address, ["function decimals() view returns (uint8)"], provider);
    const dec = await erc20.decimals();
    tokenObj.decimals = Number(dec);
    return tokenObj.decimals;
  } catch (e) {
    warn(`⚠️ Could not fetch decimals for ${tokenObj.address} — defaulting to 18. Error: ${e.message}`);
    tokenObj.decimals = 18;
    return 18;
  }
}

// Safe getAmountsOut - returns tokenAmount of token received for X USDC (amountUSDC input)
// returns number (token units, normalized to token decimals) or null on failure
async function getTokenAmountForUSDC(routerAddr, tokenObj, amountUSDC = TRADE_AMOUNT_USDC) {
  try {
    // read USDC from contract
    const usdcAddr = await arbContract.USDC();
    const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
    // amountUSDC -> USDC has 6 decimals
    const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), [usdcAddr, tokenObj.address]);
    if (!amounts || amounts.length === 0) throw new Error("empty amounts");
    const tokenAmount = ethers.formatUnits(amounts[amounts.length - 1], tokenObj.decimals || 18);
    return Number(tokenAmount);
  } catch (e) {
    // fallback to USDC -> WBTC -> token if direct pair missing
    try {
      const usdcAddr = await arbContract.USDC();
      const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
      const wbtcAddress = Object.values(tokens).find(t => t && t.decimals !== null && t.address)?.address; // rough fallback pick
      if (!wbtcAddress) throw e;
      const amounts = await router.getAmountsOut(ethers.parseUnits(amountUSDC.toString(), 6), [usdcAddr, wbtcAddress, tokenObj.address]);
      if (!amounts || amounts.length === 0) throw new Error("empty fallback amounts");
      const tokenAmount = ethers.formatUnits(amounts[amounts.length - 1], tokenObj.decimals || 18);
      return Number(tokenAmount);
    } catch (e2) {
      warn(`⚠️ getAmountsOut failed for router ${routerAddr} token ${tokenObj.address}: ${e2.message}`);
      return null;
    }
  }
}

// Simulate selling `tokenAmount` on a router — returns USDC received (number) or null
async function getUSDCForTokenAmount(routerAddr, tokenObj, tokenAmount) {
  try {
    const usdcAddr = await arbContract.USDC();
    const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);

    // convert tokenAmount -> token units (based on decimals) then get amounts out for token->USDC path
    const tokenUnits = ethers.parseUnits(tokenAmount.toString(), tokenObj.decimals || 18);
    // path: token -> USDC (reverse)
    const amounts = await router.getAmountsOut(tokenUnits, [tokenObj.address, usdcAddr]);
    if (!amounts || amounts.length === 0) throw new Error("empty amounts");
    const usdcOut = ethers.formatUnits(amounts[amounts.length - 1], 6);
    return Number(usdcOut);
  } catch (e) {
    // fallback token -> WBTC -> USDC if direct pair missing
    try {
      const usdcAddr = await arbContract.USDC();
      const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"], provider);
      const wbtc = Object.values(tokens).find(t => t && t.decimals === 8);
      if (!wbtc) throw e;
      const tokenUnits = ethers.parseUnits(tokenAmount.toString(), tokenObj.decimals || 18);
      const amounts = await router.getAmountsOut(tokenUnits, [tokenObj.address, wbtc.address, usdcAddr]);
      if (!amounts || amounts.length === 0) throw new Error("empty fallback amounts");
      const usdcOut = ethers.formatUnits(amounts[amounts.length - 1], 6);
      return Number(usdcOut);
    } catch (e2) {
      warn(`⚠️ getUSDCForTokenAmount failed for router ${routerAddr} token ${tokenObj.address}: ${e2.message}`);
      return null;
    }
  }
}

// ---------------- MAIN LOGIC ----------------
let cumulativeProfit = 0; // USDC

async function attemptArb(buyRouterAddr, sellRouterAddr, tokenObj, amountUSDC = TRADE_AMOUNT_USDC) {
  // ensure decimals known
  await ensureTokenDecimals(tokenObj);

  // Step 1: how many tokens would we get buying token with `amountUSDC` on buyRouter?
  const tokenAmount = await getTokenAmountForUSDC(buyRouterAddr, tokenObj, amountUSDC);
  if (tokenAmount === null) {
    // skip this pair
    return null;
  }

  // Step 2: how many USDC would we get selling that same token amount on sellRouter?
  const usdcOut = await getUSDCForTokenAmount(sellRouterAddr, tokenObj, tokenAmount);
  if (usdcOut === null) {
    return null;
  }

  // Normalize & compute profit
  let profitUSDC = usdcOut - amountUSDC;
  // apply slippage safety margin
  profitUSDC *= (1 - SLIPPAGE_PCT / 100);
  const profitPct = (profitUSDC / amountUSDC) * 100;

  return {
    tokenAmount,
    usdcOut,
    profitUSDC,
    profitPct
  };
}

async function executeTradeNoCallStatic(buyRouterAddr, sellRouterAddr, tokenObj, amountUSDC = TRADE_AMOUNT_USDC) {
  // Attempt actual executeArbitrage (no callStatic); if DRY_RUN or MODE=7 we do simulated only
  if (DRY_RUN || MODE === 7) {
    // Simulation-only path: accumulate simulated profit and log details
    const sim = await attemptArb(buyRouterAddr, sellRouterAddr, tokenObj, amountUSDC);
    if (!sim) {
      log(`⚠️ Simulation skipped for ${tokenObj.address} on routers ${buyRouterAddr} -> ${sellRouterAddr}`);
      return false;
    }
    if (sim.profitPct >= MIN_PROFIT_PCT) {
      cumulativeProfit += sim.profitUSDC;
      log(`🧪 [SIM] ${tokenObj.address} | buy @ ${buyRouterAddr} -> sell @ ${sellRouterAddr}`);
      log(`    tokenAmount: ${sim.tokenAmount} (token decimals ${tokenObj.decimals})`);
      log(`    usdcOut: ${fmt(sim.usdcOut,6)} USDC`);
      log(`    profit: ${fmt(sim.profitUSDC,6)} USDC (${fmt(sim.profitPct,2)}%)`);
      log(`    cumulative simulated profit: ${fmt(cumulativeProfit,6)} USDC`);
      return true;
    } else {
      log(`— [SIM] Not profitable ( ${fmt(sim.profitPct,4)}% < ${MIN_PROFIT_PCT}% )`);
      return false;
    }
  }

  // Live execution path (no callStatic): attempt to send executeArbitrage and catch revert
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouterAddr,
      sellRouterAddr,
      tokenObj.address,
      ethers.parseUnits(amountUSDC.toString(), 6),
      { gasLimit: GAS_LIMIT }
    );
    log(`⏳ TX sent: ${tx.hash}  (buy ${buyRouterAddr} sell ${sellRouterAddr} token ${tokenObj.address})`);
    const receipt = await tx.wait();
    log(`✅ TX mined: ${tx.hash} | block ${receipt.blockNumber}`);

    // compute net profit by reading contract USDC balance (assumes arb contract accumulates)
    try {
      const usdcAddr = await arbContract.USDC();
      const usdc = new ethers.Contract(usdcAddr, ["function balanceOf(address) view returns (uint256)"], provider);
      const bal = await usdc.balanceOf(CONTRACT_ADDRESS);
      const netProfit = Number(ethers.formatUnits(bal, 6)) - amountUSDC;
      cumulativeProfit += netProfit;
      log(`💹 Net USDC gained this tx: ${fmt(netProfit,6)} | cumulative: ${fmt(cumulativeProfit,6)}`);
    } catch (readErr) {
      warn(`⚠️ Could not read USDC balance after tx: ${readErr.message}`);
    }

    return true;
  } catch (txErr) {
    // handle revert / failure gracefully
    warn(`❌ TX failed for token ${tokenObj.address} buy:${buyRouterAddr} sell:${sellRouterAddr}`);
    // give full debug info
    warn("❗ TX error object:", {
      message: txErr.message,
      code: txErr.code,
      reason: txErr.reason,
      data: txErr.data
    });
    return false;
  }
}

// Scan loop (robust: one bad pair doesn't stop the program)
async function scanOnce() {
  log("🔍 Starting scan...");
  const usdcAddr = await (async () => { try { return await arbContract.USDC(); } catch (e) { warn("⚠️ Could not read USDC from contract:", e.message); return null; } })();
  if (!usdcAddr) {
    warn("⚠️ USDC address unavailable from the contract; scanning will continue but getAmountsOut will likely fail.");
  }

  const routerEntries = Object.entries(routers);
  const tokenEntries = Object.entries(tokens);

  let found = 0;
  for (const [sym, tokenObj] of tokenEntries) {
    if (!tokenObj || !tokenObj.address) continue;
    // ensure decimals (best-effort)
    await ensureTokenDecimals(tokenObj);

    for (const [buyName, buyAddr] of routerEntries) {
      for (const [sellName, sellAddr] of routerEntries) {
        if (buyName === sellName) continue;

        try {
          const result = await attemptArb(buyAddr, sellAddr, tokenObj, TRADE_AMOUNT_USDC);
          if (!result) {
            // not available (e.g., missing pair) — skip quietly
            continue;
          }
          // log opportunity info
          log(`🚨 ${sym} | Buy:${buyName} -> Sell:${sellName}`);
          log(`    round-trip USDC out: ${fmt(result.usdcOut,6)} | in: ${TRADE_AMOUNT_USDC}`);
          log(`    token amount acquired: ${result.tokenAmount} (decimals ${tokenObj.decimals})`);
          log(`    profit: ${fmt(result.profitUSDC,6)} USDC (${fmt(result.profitPct,3)}%)`);

          if (result.profitPct >= MIN_PROFIT_PCT) {
            found++;
            // If MODE=7 or DRY_RUN true, this will simulate and accumulate
            const ok = await executeTradeNoCallStatic(buyAddr, sellAddr, tokenObj, TRADE_AMOUNT_USDC);
            if (!ok) {
              log(`    → skipped execution for ${sym} ${buyName}->${sellName}`);
            }
          } else {
            log(`    → profit below threshold (${fmt(result.profitPct,3)}% < ${MIN_PROFIT_PCT}%)`);
          }
        } catch (e) {
          // ensure any single failure doesn't stop scanning
          warn(`⚠️ Unhandled error scanning ${sym} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }
  log(`🔍 Scan finished. Opportunities considered: ${found}`);
  if (MODE === 7 || DRY_RUN) {
    log(`📊 CUMULATIVE SIMULATED PROFIT: ${fmt(cumulativeProfit,6)} USDC`);
  } else {
    log(`📊 CUMULATIVE REAL PROFIT (tracked): ${fmt(cumulativeProfit,6)} USDC`);
  }
}

// ---------------- RUN ----------------
(async () => {
  log("🚀 Arb bot starting — DRY_RUN:", DRY_RUN, " MODE:", MODE);
  // run forever with interval
  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      warn("⚠️ scanOnce crashed but will continue:", e.message);
    }
    // wait 8 seconds between scans (adjustable)
    await new Promise(r => setTimeout(r, 8000));
  }
})();
