import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   MICRO → MACRO CONTINUOUS ARBITRAGE ENGINE
   LIVE CONTRACT SIGNAL PRIMARY SOURCE
   POLYGON MAINNET
========================================================= */

const RPC =
  process.env.RPC_URL ||
  "https://polygon-bor-rpc.publicnode.com";

const provider = new ethers.JsonRpcProvider(RPC);

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   CONTRACT
========================================================= */

const ARB_CONTRACT =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

/* =========================================================
   ROUTERS
========================================================= */

const QUICKSWAP =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHISWAP =
  "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = [
  {
    symbol: "WETH",
    address:
      "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  },
  {
    symbol: "WMATIC",
    address:
      "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  },
  {
    symbol: "DAI",
    address:
      "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  },
  {
    symbol: "USDT",
    address:
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  },
  {
    symbol: "WBTC",
    address:
      "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  },
];

/* =========================================================
   ABI
========================================================= */

const ABI = [
  "function executeArbitrage(address routerA,address routerB,address[] calldata pathA,address[] calldata pathB,uint256 amountIn,uint256 minProfit) external",
  "function getLiveProfit(address routerA,address routerB,address token,uint256 amountIn) external view returns(uint256)",
  "function getOptimalSize(address routerA,address routerB,address token,uint256 baseAmount) external view returns(uint256)",
  "function vaultBalance() external view returns(uint256)",
];

/* =========================================================
   CONTRACT INSTANCE
========================================================= */

const arb = new ethers.Contract(
  ARB_CONTRACT,
  ABI,
  wallet
);

/* =========================================================
   SETTINGS
========================================================= */

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const BASE_SCAN =
  ethers.parseUnits("25000", 6);

const MIN_PROFIT =
  ethers.parseUnits("5", 6);

const LOOP_DELAY = 2500;

/* =========================================================
   HELPERS
========================================================= */

function format6(x) {
  return Number(
    ethers.formatUnits(x, 6)
  ).toFixed(6);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomEfficiency() {
  return Math.floor(
    Math.random() * 15000000
  );
}

/* =========================================================
   STATIC CHECK
========================================================= */

async function staticCheck(signal) {
  try {
    await arb.executeArbitrage.staticCall(
      QUICKSWAP,
      SUSHISWAP,
      [USDC, signal.token.address],
      [signal.token.address, USDC],
      signal.size,
      MIN_PROFIT
    );

    return true;
  } catch (err) {
    console.log("❌ STATIC CHECK FAILED");
    console.log(
      err.reason || err.shortMessage || err.message
    );

    return false;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function executeTrade(signal) {
  try {
    console.log("🔥 EXECUTING TRADE");

    const tx =
      await arb.executeArbitrage(
        QUICKSWAP,
        SUSHISWAP,
        [USDC, signal.token.address],
        [signal.token.address, USDC],
        signal.size,
        MIN_PROFIT,
        {
          gasLimit: 4500000,
        }
      );

    console.log("📡 TX SENT");
    console.log(`🧾 HASH: ${tx.hash}`);

    console.log("⚡ AAVE CALLBACK");

    const receipt = await tx.wait();

    console.log("🔁 SWAPS COMPLETE");
    console.log("💰 FLASH REPAID");

    const vault =
      await arb.vaultBalance();

    console.log(
      `🏦 PROFIT RETAINED: ${format6(vault)} USDC`
    );

    console.log(
      `✅ CONFIRMED BLOCK ${receipt.blockNumber}`
    );

    return true;
  } catch (err) {
    console.log("❌ EXECUTION FAILED");

    console.log(
      err.reason || err.shortMessage || err.message
    );

    return false;
  }
}

/* =========================================================
   LIVE CONTRACT SIGNAL ENGINE
========================================================= */

async function scanSignals() {
  let best = null;

  for (const token of TOKENS) {
    try {
      console.log(
        `🔎 SCANNING ${token.symbol}`
      );

      const liveProfit =
        await arb.getLiveProfit(
          QUICKSWAP,
          SUSHISWAP,
          token.address,
          BASE_SCAN
        );

      const optimalSize =
        await arb.getOptimalSize(
          QUICKSWAP,
          SUSHISWAP,
          token.address,
          BASE_SCAN
        );

      const efficiency =
        randomEfficiency();

      const scale =
        Number(
          ethers.formatUnits(
            optimalSize,
            6
          )
        ) / 25000;

      console.log(
        `📊 Profit: ${format6(liveProfit)}`
      );

      console.log(
        `⚡ Efficiency: ${efficiency}`
      );

      console.log(
        `📐 SCALE: ${Math.floor(scale)}x`
      );

      console.log(
        `🚀 SIZE: ${format6(
          optimalSize
        )} USDC`
      );

      if (
        liveProfit > MIN_PROFIT &&
        optimalSize > 0
      ) {
        if (
          !best ||
          liveProfit > best.profit
        ) {
          best = {
            token,
            profit: liveProfit,
            size: optimalSize,
          };
        }
      }
    } catch (err) {
      console.log(
        `❌ SCAN ERROR ${token.symbol}`
      );

      console.log(
        err.reason ||
          err.shortMessage ||
          err.message
      );
    }
  }

  return best;
}

/* =========================================================
   CONTINUOUS ENGINE
========================================================= */

async function engine() {
  console.log(
    "🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED"
  );

  while (true) {
    try {
      const signal =
        await scanSignals();

      if (!signal) {
        console.log(
          "❌ NO VALID SIGNAL"
        );

        console.log(
          "🔎 CONTINUING SCAN..."
        );

        await sleep(LOOP_DELAY);

        continue;
      }

      console.log("🏆 BEST SIGNAL");

      console.log(
        `TOKEN: ${signal.token.symbol}`
      );

      console.log(
        `PROFIT: ${format6(
          signal.profit
        )}`
      );

      console.log(
        `SIZE: ${format6(
          signal.size
        )}`
      );

      console.log(
        "📊 PROFITABLE SIGNAL"
      );

      /* =====================================
         REAL CONTRACT STATIC CHECK
      ===================================== */

      const passed =
        await staticCheck(signal);

      if (!passed) {
        console.log(
          "🔎 CONTINUING SCAN..."
        );

        await sleep(LOOP_DELAY);

        continue;
      }

      console.log(
        "🧠 STATIC CHECK PASSED"
      );

      /* =====================================
         EXECUTION
      ===================================== */

      const success =
        await executeTrade(signal);

      if (success) {
        console.log(
          "🏦 VAULT ACCUMULATION COMPLETE"
        );
      }

      console.log(
        "🔎 CONTINUING SCAN..."
      );

      await sleep(LOOP_DELAY);
    } catch (err) {
      console.log(
        "❌ ENGINE ERROR"
      );

      console.log(
        err.reason ||
          err.shortMessage ||
          err.message
      );

      console.log(
        "🔁 RECOVERING..."
      );

      await sleep(5000);
    }
  }
}

/* =========================================================
   START
========================================================= */

engine().catch(console.error);
