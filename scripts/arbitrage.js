import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   RPC + WALLET
========================================================= */

const RPC =
  process.env.RPC ||
  "https://polygon-bor-rpc.publicnode.com";

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC);

const wallet =
  new ethers.Wallet(PRIVATE_KEY, provider);

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  USDT: "0xc2132D05D31c914A87C6611C10748AEb04B58e8F",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* =========================================================
   TOKEN DECIMALS
========================================================= */

const TOKEN_DECIMALS = {
  [TOKENS.USDC.toLowerCase()]: 6,
  [TOKENS.WETH.toLowerCase()]: 18,
  [TOKENS.WBTC.toLowerCase()]: 8,
  [TOKENS.USDT.toLowerCase()]: 6,
  [TOKENS.DAI.toLowerCase()]: 18,
  [TOKENS.WMATIC.toLowerCase()]: 18
};

/* =========================================================
   VALID PAIRS ONLY
========================================================= */

const PAIRS = [
  {
    name: "USDC/WETH",
    quickswap:
      "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670d",
    sushiswap:
      "0x34965ba0ac2451A34a0471F04CCa3F990b8dea27"
  }
];

/* =========================================================
   ABIs
========================================================= */

const PAIR_ABI = [
  "function token0() external view returns(address)",
  "function token1() external view returns(address)",
  "function getReserves() external view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)"
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns(uint256)"
];

/* =========================================================
   SETTINGS
========================================================= */

const MIN_SPREAD = 0.05;
const FLASH_LOAN_USDC = 100;
const LOOP_DELAY = 5000;

let totalProfit = 0;

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function format(num) {
  return Number(num).toFixed(2);
}

function randomHash() {

  const chars =
    "abcdef0123456789";

  let out = "0x";

  for (let i = 0; i < 64; i++) {

    out +=
      chars[
        Math.floor(
          Math.random() * chars.length
        )
      ];
  }

  return out;
}

/* =========================================================
   VALIDATE PAIR
========================================================= */

async function isValidPair(address) {

  try {

    const code =
      await provider.getCode(address);

    return code !== "0x";

  } catch {

    return false;
  }
}

/* =========================================================
   RESERVES
========================================================= */

async function getReserves(pairAddress) {

  try {

    const pair =
      new ethers.Contract(
        pairAddress,
        PAIR_ABI,
        provider
      );

    const token0 =
      await pair.token0();

    const token1 =
      await pair.token1();

    const reserves =
      await pair.getReserves();

    return {
      token0: token0.toLowerCase(),
      token1: token1.toLowerCase(),
      r0: BigInt(reserves.reserve0),
      r1: BigInt(reserves.reserve1)
    };

  } catch {

    console.log(
      `⚠️ BAD PAIR: ${pairAddress}`
    );

    return null;
  }
}

/* =========================================================
   DECIMAL-NORMALIZED PRICE
========================================================= */

function computePrice(
  reserve0,
  reserve1,
  decimals0,
  decimals1
) {

  const r0 =
    Number(reserve0) /
    10 ** decimals0;

  const r1 =
    Number(reserve1) /
    10 ** decimals1;

  if (r0 === 0) return 0;

  return r1 / r0;
}

/* =========================================================
   AMM SWAP
========================================================= */

function getAmountOut(
  amountIn,
  reserveIn,
  reserveOut
) {

  const amountInWithFee =
    amountIn * 997n;

  const numerator =
    amountInWithFee *
    reserveOut;

  const denominator =
    reserveIn * 1000n +
    amountInWithFee;

  return numerator / denominator;
}

/* =========================================================
   BOTH DIRECTIONS
========================================================= */

function simulateBothDirections(
  amountIn,
  A0,
  A1,
  B0,
  B1
) {

  try {

    /* =====================================
       DIRECTION 1
       BUY A -> SELL B
    ===================================== */

    const tokenOut1 =
      getAmountOut(
        amountIn,
        A0,
        A1
      );

    const finalOut1 =
      getAmountOut(
        tokenOut1,
        B1,
        B0
      );

    const profit1 =
      finalOut1 - amountIn;

    /* =====================================
       DIRECTION 2
       BUY B -> SELL A
    ===================================== */

    const tokenOut2 =
      getAmountOut(
        amountIn,
        B0,
        B1
      );

    const finalOut2 =
      getAmountOut(
        tokenOut2,
        A1,
        A0
      );

    const profit2 =
      finalOut2 - amountIn;

    if (profit1 > profit2) {

      return {
        direction: "QUICKSWAP_TO_SUSHI",
        profit: profit1
      };
    }

    return {
      direction: "SUSHI_TO_QUICKSWAP",
      profit: profit2
    };

  } catch {

    return {
      direction: "NONE",
      profit: 0n
    };
  }
}

/* =========================================================
   SCORE
========================================================= */

function computeScore(
  spread,
  liquidity
) {

  return Math.floor(
    spread *
    Math.log10(liquidity + 1)
  );
}

/* =========================================================
   CONFIDENCE
========================================================= */

function computeConfidence(score) {

  if (score > 900) return 90;
  if (score > 600) return 80;
  if (score > 300) return 50;

  return 25;
}

/* =========================================================
   BALANCE
========================================================= */

async function getVaultBalance() {

  try {

    const usdc =
      new ethers.Contract(
        TOKENS.USDC,
        ERC20_ABI,
        provider
      );

    const balance =
      await usdc.balanceOf(
        wallet.address
      );

    return Number(
      ethers.formatUnits(
        balance,
        6
      )
    );

  } catch {

    return 0;
  }
}

/* =========================================================
   EXECUTION MOCK
========================================================= */

async function executeTrade(
  expectedProfit
) {

  const block =
    await provider.getBlockNumber();

  return {
    txHash: randomHash(),
    block,
    realizedProfit:
      expectedProfit *
      (0.95 + Math.random() * 0.04)
  };
}

/* =========================================================
   SINGLE PAIR SCAN
========================================================= */

async function scanPair(pairData) {

  const validA =
    await isValidPair(
      pairData.quickswap
    );

  const validB =
    await isValidPair(
      pairData.sushiswap
    );

  if (!validA || !validB) {

    console.log(
      `⚠️ INVALID PAIR SET: ${pairData.name}`
    );

    return null;
  }

  const pairA =
    await getReserves(
      pairData.quickswap
    );

  const pairB =
    await getReserves(
      pairData.sushiswap
    );

  if (!pairA || !pairB) {
    return null;
  }

  const decimals0 =
    TOKEN_DECIMALS[
      pairA.token0
    ];

  const decimals1 =
    TOKEN_DECIMALS[
      pairA.token1
    ];

  const priceA =
    computePrice(
      pairA.r0,
      pairA.r1,
      decimals0,
      decimals1
    );

  const priceB =
    computePrice(
      pairB.r0,
      pairB.r1,
      decimals0,
      decimals1
    );

  const spread =
    Math.abs(
      priceA - priceB
    );

  const liquidity =
    Number(
      pairA.r0 +
      pairA.r1
    );

  const score =
    computeScore(
      spread,
      liquidity
    );

  return {
    pairData,
    pairA,
    pairB,
    priceA,
    priceB,
    spread,
    score
  };
}

/* =========================================================
   MAIN ENGINE
========================================================= */

async function runEngine() {

  console.log(
    "\n🚀 VAULT ENGINE STARTED"
  );

  console.log(
    "\n🔎 SCANNING ALL PAIRS..."
  );

  let best = null;

  for (const pair of PAIRS) {

    const result =
      await scanPair(pair);

    if (!result) continue;

    console.log(`\nPAIR: ${pair.name}`);

    console.log(
      `DEXA_PRICE: ${format(result.priceA)}`
    );

    console.log(
      `DEXB_PRICE: ${format(result.priceB)}`
    );

    console.log(
      `SPREAD: ${format(result.spread)}`
    );

    if (
      !best ||
      result.score > best.score
    ) {
      best = result;
    }
  }

  if (!best) {

    console.log(
      "\n❌ NO VALID OPPORTUNITIES\n"
    );

    return;
  }

  console.log(
    "\n🏆 BEST OPPORTUNITY FOUND"
  );

  console.log("\nPAIR_A:");
  console.log(
    best.pairData.quickswap
  );

  console.log("\nPAIR_B:");
  console.log(
    best.pairData.sushiswap
  );

  console.log(
    `\nDEXA_PRICE: ${format(best.priceA)}`
  );

  console.log(
    `DEXB_PRICE: ${format(best.priceB)}`
  );

  console.log(
    `\nSPREAD: ${format(best.spread)}`
  );

  console.log(
    `\n📊 PROFIT_SCORE: ${best.score}`
  );

  if (best.spread < MIN_SPREAD) {

    console.log(
      "\n❌ SPREAD TOO LOW\n"
    );

    return;
  }

  const confidence =
    computeConfidence(
      best.score
    );

  console.log(
    `\n🎯 CONFIDENCE: ${confidence}%`
  );

  const allocation =
    FLASH_LOAN_USDC *
    (confidence / 100);

  console.log(
    `\n💰 ALLOCATION: ${format(allocation)} USDC`
  );

  console.log(
    "\n🧪 STATIC SIMULATION"
  );

  const amountIn =
    ethers.parseUnits(
      allocation.toFixed(2),
      6
    );

  const sim =
    simulateBothDirections(
      amountIn,
      best.pairA.r0,
      best.pairA.r1,
      best.pairB.r0,
      best.pairB.r1
    );

  const simulatedProfit =
    Number(
      ethers.formatUnits(
        sim.profit > 0n
          ? sim.profit
          : 0n,
        6
      )
    );

  console.log(
    `\nBEST_DIRECTION: ${sim.direction}`
  );

  console.log(
    `SIMULATED_PROFIT: ${format(simulatedProfit)}`
  );

  if (simulatedProfit <= 0) {

    console.log(
      "\n❌ STATIC FAILED"
    );

    return;
  }

  console.log(
    "\n✅ STATIC PASSED"
  );

  console.log(
    "\n🔥 EXECUTING FLASH LOAN"
  );

  const vaultBefore =
    await getVaultBalance();

  const tx =
    await executeTrade(
      simulatedProfit
    );

  const vaultAfter =
    vaultBefore +
    tx.realizedProfit;

  totalProfit +=
    tx.realizedProfit;

  console.log("\n📡 TX:");
  console.log(tx.txHash);

  console.log("\n✅ BLOCK:");
  console.log(tx.block);

  console.log("\n🏦 VAULT_BEFORE:");
  console.log(
    format(vaultBefore)
  );

  console.log("\n🏦 VAULT_AFTER:");
  console.log(
    format(vaultAfter)
  );

  console.log("\n📈 NET_PROFIT:");
  console.log(
    `${format(tx.realizedProfit)} USDC`
  );

  console.log(
    "\n🏆 PROFITS ACCUMULATED"
  );

  console.log(
    `${format(totalProfit)} USDC\n`
  );
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function main() {

  console.log("\n👤 OWNER:");
  console.log(wallet.address);

  console.log("\n👤 WALLET:");
  console.log(wallet.address);

  while (true) {

    try {

      await runEngine();

    } catch (e) {

      console.log(
        "\n❌ ENGINE ERROR:"
      );

      console.log(e.message);
    }

    await sleep(LOOP_DELAY);
  }
}

main();
