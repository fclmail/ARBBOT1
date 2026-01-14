import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

/* ================= CONFIG ================= */

const RPC = process.env.RPC_POLYGON;
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!RPC || !PRIVATE_KEY) {
  throw new Error("Missing RPC_POLYGON or WALLET_PRIVATE_KEY");
}

const MIN_TRADE_USDC = 0.03;
const MIN_EXPECTED_PROFIT = 0.000001;
const SLIPPAGE_PCT = 0.05; // not directly used in on-chain; kept for reference
const SCAN_DELAY_MS = 8000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xe9068882B5E499Ca3c4ed1EDfd87aA6f7b57C159";

/*
  Best practice: load a full ABI JSON if possible to ensure exact matching with deployed contract.
  If you only have the function signatures, you can keep this minimal but be aware of drift risks.
*/
const vaultAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "buyRouter", "type": "address" },
      { "internalType": "address", "name": "sellRouter", "type": "address" },
      { "internalType": "uint256", "name": "amountInUSDC", "type": "uint256" },
      { "internalType": "address[]", "name": "pathToToken", "type": "address[]" },
      { "internalType": "address[]", "name": "pathToUSDC", "type": "address[]" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "usdc",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  }
];

// Normalize contract object
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Quote the amountOut for a given path using a specific router. Returns BigNumber or null on failure. */
async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch (e) {
    console.warn(`⚠️ quote failed for router ${routerAddr} path ${path?.join(",")} with error: ${e?.message ?? e}`);
    return null;
  }
}

/* ================= CORE LOGIC ================= */

/**
 * Attempt a single arbitrage cycle.
 * Returns true if an arb was executed, false otherwise.
 */
async function tryArb(buyRouter, sellRouter, tokenAddr) {
  try {
    // Resolve vault USDC token address
    const usdc = await vault.usdc();
    // Use 6 decimals for USDC
    const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

    // Direct path: USDC -> TOKEN, then TOKEN -> USDC
    const directPathBuy = [usdc, tokenAddr];
    const directPathSell = [tokenAddr, usdc];

    // Get quotes
    const buyOut = await quote(buyRouter, amountIn, directPathBuy);
    if (!buyOut) {
      console.log(`⚠️ buyOut quote failed for ${buyRouter} -> ${tokenAddr}`);
      return false;
    }

    const sellOut = await quote(sellRouter, buyOut, directPathSell);
    if (!sellOut) {
      console.log(`⚠️ sellOut quote failed for ${sellRouter} with amount ${buyOut.toString()}`);
      return false;
    }

    // Normalize results
    const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));
    const profit = receivedUSDC - MIN_TRADE_USDC;

    // Respect required profit
    if (profit < MIN_EXPECTED_PROFIT) {
      // Not profitable enough
      console.log(
        `🔎 PROFIT NOT ENOUGH | Expected ${MIN_EXPECTED_PROFIT.toFixed(6)} USDC, got ${profit.toFixed(6)} USDC`
      );
      return false;
    }

    // Deadline
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

    // Basic safety: ensure paths are sane (no zero addresses)
    if (!buyRouter || !sellRouter || !tokenAddr) {
      console.log("⚠️ Invalid addresses in arb parameters");
      return false;
    }

    // Pre-check: optional slippage guard (informational only; on-chain will enforce)
    // Here we ensure the expected buyOut is not unrealistically far from quote
    // This is a light guard; you can tune or remove as needed.
    const maxAcceptableSell = buyOut.mul(100 - Math.floor(SLIPPAGE_PCT * 100)).div(100);
    if (sellOut.lt(maxAcceptableSell)) {
      console.log("⚠️ On-chain result shows worse price than slippage guard, skipping.");
      return false;
    }

    console.log(`🔥 ARB FOUND | Profit ≈ ${profit.toFixed(6)} USDC | Buy ${buyRouter} -> ${tokenAddr}, Sell ${sellRouter} -> USDC`);

    // Execute on-chain arbitrage
    try {
      const tx = await vault.executeArbitrage(
        buyRouter,
        sellRouter,
        amountIn,
        directPathBuy,
        directPathSell,
        deadline
      );

      console.log(`⛓ TX SENT: ${tx.hash}`);
      await tx.wait();
      console.log(`✅ PROFIT DEPOSITED TO VAULT`);
      return true;
    } catch (txErr) {
      // Revert reason handling (if available)
      const message = txErr?.message ?? txErr?.toString();
      console.warn(`⚠️ ARB EXECUTION REVERTED: ${message}`);
      // Optional: parse for 'execution reverted: reason'
      return false;
    }
  } catch (err) {
    console.warn(`⚠️ tryArb encountered error: ${err?.message ?? err}`);
    return false;
  }
}

/* ================= SCANNER ================= */

async function scan() {
  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        try {
          await tryArb(buy, sell, token);
          await sleep(1200);
        } catch (e) {
          console.log(`⚠️ SCAN CATCH: ${e?.message ?? e}`);
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

(async () => {
  console.log("🚀 Arbitrage bot started");
  // Optional: preload and validate vault connection
  try {
    const usdcAddr = await vault.usdc();
    console.log(`Vault USDC address: ${usdcAddr}`);
  } catch (e) {
    console.error(`Failed to query vault.usdc() during init: ${e?.message ?? e}`);
  }

  // Main loop
  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(`Unhandled error in scan loop: ${e?.message ?? e}`);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
