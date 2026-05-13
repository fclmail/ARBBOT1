import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const RPC =
  process.env.RPC ||
  "https://polygon-bor-rpc.publicnode.com";

const PRIVATE_KEY =
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

const provider =
  new ethers.JsonRpcProvider(RPC);

const wallet =
  new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

/* =========================================================
   ADDRESSES
========================================================= */

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const WETH =
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

/*
  REAL POLYGON LP PAIRS
*/

/* QUICKSWAP USDC/WETH */
const PAIR_A =
  "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670d";

/* SUSHISWAP USDC/WETH */
const PAIR_B =
  "0x34965ba0ac2451A34a0471F04CCa3F990b8dea27";

/*
  DEPLOYED CONTRACT
*/

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

/* =========================================================
   ABI
========================================================= */

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns(uint256)"
];

const ARB_ABI = [
  "function owner() view returns(address)",

  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",

  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external"
];

/* =========================================================
   CONTRACTS
========================================================= */

const arb =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    ARB_ABI,
    wallet
  );

const usdc =
  new ethers.Contract(
    USDC,
    ERC20_ABI,
    provider
  );

/* =========================================================
   SETTINGS
========================================================= */

const LOOP_DELAY = 5000;

const MIN_PROFIT =
  50n * 10n ** 6n;

const EXECUTION_LOCK = {
  active: false
};

/* =========================================================
   HELPERS
========================================================= */

function fmt(x) {

  return Number(
    ethers.formatUnits(x || 0n, 6)
  ).toFixed(2);
}

function sleep(ms) {

  return new Promise(
    r => setTimeout(r, ms)
  );
}

/* =========================================================
   VALIDATE PAIR
========================================================= */

async function validatePair(address) {

  const code =
    await provider.getCode(address);

  if (code === "0x") {

    throw new Error(
      `INVALID_PAIR:${address}`
    );
  }
}

/* =========================================================
   NORMALIZED RESERVES
========================================================= */

async function getReserves(
  pairAddress,
  baseToken
) {

  await validatePair(pairAddress);

  const pair =
    new ethers.Contract(
      pairAddress,
      PAIR_ABI,
      provider
    );

  const reserves =
    await pair.getReserves();

  const token0 =
    await pair.token0();

  const token1 =
    await pair.token1();

  const r0 =
    BigInt(reserves[0]);

  const r1 =
    BigInt(reserves[1]);

  /*
    NORMALIZE ORDER
  */

  if (
    token0.toLowerCase() ===
    baseToken.toLowerCase()
  ) {

    return {
      reserveBase: r0,
      reserveQuote: r1,
      token0,
      token1
    };
  }

  return {
    reserveBase: r1,
    reserveQuote: r0,
    token0,
    token1
  };
}

/* =========================================================
   PRICE MODEL
========================================================= */

function computePrice(
  reserveBase,
  reserveQuote
) {

  if (
    reserveBase === 0n
  ) {
    return 0;
  }

  return Number(
    (reserveQuote * 1000000n)
      / reserveBase
  ) / 1000000;
}

/* =========================================================
   SCORE MODEL
========================================================= */

function computeScore(
  spread,
  liquidity
) {

  if (spread <= 0) {
    return 0;
  }

  return Math.floor(
    spread *
    Math.log10(
      liquidity / 1e6
    ) *
    100
  );
}

/* =========================================================
   VAULT BALANCE
========================================================= */

async function getVaultBalance() {

  return await usdc.balanceOf(
    CONTRACT_ADDRESS
  );
}

/* =========================================================
   CONFIDENCE MODEL
========================================================= */

function confidenceLevel(score) {

  if (score > 800) {
    return 80;
  }

  if (score > 500) {
    return 50;
  }

  if (score > 250) {
    return 25;
  }

  return 10;
}

function allocationFromConfidence(
  confidence,
  vaultBalance
) {

  return (
    vaultBalance *
    BigInt(confidence)
  ) / 100n;
}

/* =========================================================
   GAS SETTINGS
========================================================= */

async function getGasSettings() {

  const fee =
    await provider.getFeeData();

  return {
    maxFeePerGas:
      fee.maxFeePerGas ||
      ethers.parseUnits(
        "120",
        "gwei"
      ),

    maxPriorityFeePerGas:
      fee.maxPriorityFeePerGas ||
      ethers.parseUnits(
        "40",
        "gwei"
      )
  };
}

/* =========================================================
   STATIC SIMULATION
========================================================= */

async function staticSimulation(
  amount
) {

  try {

    const result =
      await arb.simulateArbitrageProfit(
        PAIR_A,
        PAIR_B,
        amount,
        [USDC, WETH],
        [WETH, USDC]
      );

    return {
      finalAmount:
        result[0],

      profit:
        result[1]
    };

  } catch (e) {

    console.log(
      "❌ STATIC ERROR:",
      e.message
    );

    return {
      finalAmount: 0n,
      profit: 0n
    };
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function executeTrade(
  amount
) {

  if (
    EXECUTION_LOCK.active
  ) {

    console.log(
      "⏳ EXECUTION LOCK"
    );

    return;
  }

  EXECUTION_LOCK.active = true;

  try {

    console.log(
      "\n🔥 EXECUTING FLASH LOAN\n"
    );

    const before =
      await getVaultBalance();

    const gas =
      await getGasSettings();

    const tx =
      await arb.executeBestFlashLoanArbitrage(
        PAIR_A,
        PAIR_B,
        [amount],
        [USDC, WETH],
        [WETH, USDC],
        Math.floor(
          Date.now() / 1000
        ) + 120,
        {
          gasLimit: 3000000,
          maxFeePerGas:
            gas.maxFeePerGas,
          maxPriorityFeePerGas:
            gas.maxPriorityFeePerGas
        }
      );

    console.log(
      "📡 TX:"
    );

    console.log(
      tx.hash
    );

    const receipt =
      await tx.wait();

    const after =
      await getVaultBalance();

    const net =
      after - before;

    console.log(
      "\n✅ BLOCK:"
    );

    console.log(
      receipt.blockNumber
    );

    console.log(
      "\n🏦 VAULT_BEFORE:"
    );

    console.log(
      fmt(before)
    );

    console.log(
      "\n🏦 VAULT_AFTER:"
    );

    console.log(
      fmt(after)
    );

    console.log(
      "\n📈 NET_PROFIT:"
    );

    console.log(
      `${fmt(net)} USDC`
    );

    console.log(
      "\n🏆 PROFITS ACCUMULATED\n"
    );

  } catch (e) {

    console.log(
      "❌ EXECUTION FAILED:",
      e.message
    );

  } finally {

    EXECUTION_LOCK.active = false;
  }
}

/* =========================================================
   CORE ENGINE
========================================================= */

async function runVaultEngine() {

  try {

    /*
      RESERVE SCAN
    */

    const A =
      await getReserves(
        PAIR_A,
        USDC
      );

    const B =
      await getReserves(
        PAIR_B,
        USDC
      );

    const priceA =
      computePrice(
        A.reserveBase,
        A.reserveQuote
      );

    const priceB =
      computePrice(
        B.reserveBase,
        B.reserveQuote
      );

    const spread =
      Math.abs(
        priceA - priceB
      );

    console.log(
      "\n🚀 VAULT ENGINE STARTED\n"
    );

    console.log(
      "🔎 RESERVE_SCAN\n"
    );

    console.log(
      "PAIR_A:"
    );

    console.log(
      PAIR_A
    );

    console.log(
      "\nPAIR_B:"
    );

    console.log(
      PAIR_B
    );

    console.log(
      `\nDEXA_PRICE: ${priceA.toFixed(2)}`
    );

    console.log(
      `DEXB_PRICE: ${priceB.toFixed(2)}`
    );

    console.log(
      `\nSPREAD: ${spread.toFixed(2)}\n`
    );

    /*
      SCORE
    */

    const liquidity =
      Number(
        A.reserveBase +
        A.reserveQuote +
        B.reserveBase +
        B.reserveQuote
      );

    const score =
      computeScore(
        spread,
        liquidity
      );

    console.log(
      `📊 PROFIT_SCORE: ${score}\n`
    );

    if (score <= 0) {

      console.log(
        "❌ NO EDGE FOUND\n"
      );

      return;
    }

    /*
      CONFIDENCE
    */

    const confidence =
      confidenceLevel(score);

    console.log(
      `🎯 CONFIDENCE: ${confidence}%\n`
    );

    /*
      VAULT
    */

    const vaultBalance =
      await getVaultBalance();

    const allocation =
      allocationFromConfidence(
        confidence,
        vaultBalance
      );

    console.log(
      `💰 ALLOCATION: ${fmt(allocation)} USDC\n`
    );

    /*
      STATIC CHECK
    */

    console.log(
      "🧪 STATIC SIMULATION\n"
    );

    const simulation =
      await staticSimulation(
        allocation
      );

    console.log(
      `SIMULATED_PROFIT: ${fmt(simulation.profit)}\n`
    );

    if (
      simulation.profit <
      MIN_PROFIT
    ) {

      console.log(
        "❌ STATIC FAILED\n"
      );

      return;
    }

    console.log(
      "✅ STATIC PASSED\n"
    );

    /*
      EXECUTE
    */

    await executeTrade(
      allocation
    );

  } catch (e) {

    console.log(
      "⚠️ ERROR:",
      e.message
    );

    await sleep(10000);
  }
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function main() {

  const owner =
    await arb.owner();

  console.log(
    "\n👤 OWNER:"
  );

  console.log(
    owner
  );

  console.log(
    "\n👤 WALLET:"
  );

  console.log(
    wallet.address
  );

  while (true) {

    await runVaultEngine();

    await sleep(
      LOOP_DELAY
    );
  }
}

main().catch(console.error);
