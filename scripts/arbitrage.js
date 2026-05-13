
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   ENV
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

/* =========================================================
   RPC FAILOVER
========================================================= */

const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc-mainnet.maticvigil.com",
  "https://polygon.llamarpc.com"
];

let rpcIndex = 0;

function createProvider() {
  return new ethers.JsonRpcProvider(RPCS[rpcIndex]);
}

let provider = createProvider();

async function rotateRPC() {

  rpcIndex = (rpcIndex + 1) % RPCS.length;

  console.log(`\n🔄 SWITCHING RPC -> ${RPCS[rpcIndex]}`);

  provider = createProvider();

  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  arb = new ethers.Contract(
    CONTRACT_ADDRESS,
    arbAbi,
    wallet
  );
}

/* =========================================================
   WALLET
========================================================= */

let wallet = new ethers.Wallet(
  PRIVATE_KEY,
  provider
);

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

/* =========================================================
   ABI
========================================================= */

const arbAbi = [
  "function owner() view returns(address)",
  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns(uint256,uint256)",
  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256) external"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const routerAbi = [
  "function getAmountsOut(uint amountIn,address[] memory path) external view returns(uint[] memory amounts)"
];

let arb = new ethers.Contract(
  CONTRACT_ADDRESS,
  arbAbi,
  wallet
);

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};

const USDC = TOKENS.USDC;

/* =========================================================
   DEX ROUTERS
========================================================= */

const DEXES = {
  QUICKSWAP:
    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",

  SUSHISWAP:
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

/* =========================================================
   SETTINGS
========================================================= */

const LOOP_DELAY = 3000;

const WORKERS = 4;

const DRY_RUN = false;

const MIN_PROFIT_USDC = 25n * 10n ** 6n;

const EXECUTION_LOCK = {
  active: false
};

/* =========================================================
   HELPERS
========================================================= */

const sleep = (ms) =>
  new Promise(r => setTimeout(r, ms));

const fmt = (x) =>
  Number(
    ethers.formatUnits(x || 0n, 6)
  ).toFixed(6);

function safeNumber(x) {
  try {
    return Number(x);
  } catch {
    return 0;
  }
}

/* =========================================================
   FIXED PROFIT MODEL
========================================================= */

function computeRequiredProfit(size) {

  /*
    FIXES INCLUDED:

    - Removed broken 120x multiplier
    - Added realistic slippage
    - Added proper gas model
    - Prevented impossible thresholds
  */

  const flashFee =
    (size * 9n) / 10000n;

  const gasEstimate =
    15n * 10n ** 6n;

  const slippageRisk =
    (size * 3n) / 1000n;

  const base =
    flashFee +
    gasEstimate +
    slippageRisk;

  /*
    1.2x safety buffer
  */

  return base + (base * 2n) / 10n;
}

/* =========================================================
   DYNAMIC SIZE CURVE
========================================================= */

function buildDepthSizes() {

  return [
    5000n * 10n ** 6n,
    10000n * 10n ** 6n,
    25000n * 10n ** 6n,
    50000n * 10n ** 6n,
    100000n * 10n ** 6n,
    250000n * 10n ** 6n,
    500000n * 10n ** 6n,
    1000000n * 10n ** 6n
  ];
}

/* =========================================================
   BALANCES
========================================================= */

async function getVaultBalance() {

  const usdc =
    new ethers.Contract(
      USDC,
      erc20Abi,
      provider
    );

  return await usdc.balanceOf(
    CONTRACT_ADDRESS
  );
}

async function getMaticBalance() {
  return await provider.getBalance(
    CONTRACT_ADDRESS
  );
}

/* =========================================================
   GAS ESTIMATION
========================================================= */

async function getGasSettings() {

  const fee =
    await provider.getFeeData();

  return {
    maxFeePerGas:
      fee.maxFeePerGas ||
      ethers.parseUnits("120", "gwei"),

    maxPriorityFeePerGas:
      fee.maxPriorityFeePerGas ||
      ethers.parseUnits("40", "gwei")
  };
}

/* =========================================================
   REAL PRICE FETCHING
========================================================= */

async function getDexQuote(
  routerAddress,
  amountIn,
  path
) {

  try {

    const router =
      new ethers.Contract(
        routerAddress,
        routerAbi,
        provider
      );

    const amounts =
      await router.getAmountsOut(
        amountIn,
        path
      );

    return amounts[
      amounts.length - 1
    ];

  } catch {

    return 0n;
  }
}

/* =========================================================
   REAL SPREAD DETECTION
========================================================= */

async function detectSpread(tokenName) {

  const token =
    TOKENS[tokenName];

  if (!token) {
    return null;
  }

  const probe =
    10000n * 10n ** 6n;

  const dexEntries =
    Object.entries(DEXES);

  let best = null;

  for (const [buyName, buyDex] of dexEntries) {

    for (const [sellName, sellDex] of dexEntries) {

      if (buyDex === sellDex) {
        continue;
      }

      try {

        const outToken =
          await getDexQuote(
            buyDex,
            probe,
            [USDC, token]
          );

        if (outToken === 0n) {
          continue;
        }

        const backToUSDC =
          await getDexQuote(
            sellDex,
            outToken,
            [token, USDC]
          );

        const profit =
          backToUSDC - probe;

        console.log(
          `📡 ${buyName} -> ${sellName} | ${fmt(profit)}`
        );

        if (
          !best ||
          profit > best.profit
        ) {

          best = {
            buy: buyDex,
            sell: sellDex,
            buyName,
            sellName,
            profit,
            buyPath: [USDC, token],
            sellPath: [token, USDC]
          };
        }

      } catch (e) {

        console.log(
          `❌ ROUTE FAIL ${buyName} ${sellName}`
        );
      }
    }
  }

  return best;
}

/* =========================================================
   STATIC CHECK
========================================================= */

async function staticCheck(
  spread,
  size
) {

  try {

    const sim =
      await arb.simulateArbitrageProfit(
        spread.buy,
        spread.sell,
        size,
        spread.buyPath,
        spread.sellPath
      );

    return sim[1];

  } catch {

    return 0n;
  }
}

/* =========================================================
   DEPTH ANALYSIS
========================================================= */

async function runDepthAnalysis(
  tokenName
) {

  console.log(
    `\n🔎 SCANNING ${tokenName}`
  );

  const spread =
    await detectSpread(tokenName);

  if (!spread) {

    console.log(
      "❌ NO ROUTES FOUND"
    );

    return null;
  }

  console.log(
    `🧠 BEST ROUTE ${spread.buyName} -> ${spread.sellName}`
  );

  const sizes =
    buildDepthSizes();

  let bestSignal = null;

  let peakProfit = 0n;

  let lastProfit = 0n;

  let liquidityWall = null;

  for (const size of sizes) {

    try {

      const result =
        await arb.simulateArbitrageProfit(
          spread.buy,
          spread.sell,
          size,
          spread.buyPath,
          spread.sellPath
        );

      const finalUSDC =
        result[0];

      const profit =
        result[1];

      const required =
        computeRequiredProfit(size);

      const efficiency =
        size > 0n
          ? Number(
              (profit * 1000000n) / size
            )
          : 0;

      const slope =
        lastProfit > 0n
          ? safeNumber(
              profit - lastProfit
            ) / safeNumber(size)
          : 0;

      lastProfit = profit;

      console.log(
        `SIZE ${fmt(size)} | PROFIT ${fmt(profit)} | REQUIRED ${fmt(required)}`
      );

      console.log(
        `⚡ EFFICIENCY ${efficiency}`
      );

      if (
        profit === 0n &&
        size >=
          500000n * 10n ** 6n
      ) {

        console.log(
          "🛑 CURVE COLLAPSED"
        );

        break;
      }

      if (
        !liquidityWall &&
        profit < required
      ) {

        liquidityWall = size;
      }

      if (
        peakProfit > 0n &&
        profit <
          (peakProfit * 70n) / 100n
      ) {

        console.log(
          "⚠️ LIQUIDITY COLLAPSE"
        );

        break;
      }

      /*
        MAIN EXECUTION FILTER
      */

      if (
        profit > required &&
        profit > MIN_PROFIT_USDC &&
        profit > peakProfit
      ) {

        peakProfit = profit;

        bestSignal = {
          token: tokenName,
          route: spread,
          size,
          estimatedFinalUSDC:
            finalUSDC,
          estimatedProfit:
            profit,
          efficiency,
          slope,
          liquidityWall
        };
      }

    } catch (e) {

      console.log(
        `❌ DEPTH ERROR ${e.message}`
      );

      await rotateRPC();
    }
  }

  if (!bestSignal) {

    console.log(
      "\n❌ NO EXECUTABLE SIZE FOUND"
    );

    return null;
  }

  console.log(
    "\n🏆 BEST EXECUTABLE SIGNAL"
  );

  console.log(
    `TOKEN ${bestSignal.token}`
  );

  console.log(
    `SIZE ${fmt(bestSignal.size)}`
  );

  console.log(
    `PROFIT ${fmt(bestSignal.estimatedProfit)}`
  );

  console.log(
    `EFFICIENCY ${bestSignal.efficiency}`
  );

  console.log(
    `LIQUIDITY WALL ${
      bestSignal.liquidityWall
        ? fmt(
            bestSignal.liquidityWall
          )
        : "NONE"
    }`
  );

  /*
    STATIC VALIDATION
  */

  console.log(
    "\n🧪 STATIC SIMULATION"
  );

  const staticProfit =
    await staticCheck(
      spread,
      bestSignal.size
    );

  console.log(
    `📊 STATIC RESULT ${fmt(staticProfit)}`
  );

  /*
    STATIC PASS FIX
  */

  if (
    staticProfit <
    (bestSignal.estimatedProfit *
      80n) /
      100n
  ) {

    console.log(
      "❌ STATIC FAILED"
    );

    return null;
  }

  console.log(
    "✅ STATIC PASSED"
  );

  return bestSignal;
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(signal) {

  if (EXECUTION_LOCK.active) {

    console.log(
      "⏳ EXECUTION LOCK ACTIVE"
    );

    return;
  }

  EXECUTION_LOCK.active = true;

  try {

    console.log(
      "\n🔥 EXECUTING TRADE"
    );

    const before =
      await getVaultBalance();

    const matic =
      await getMaticBalance();

    console.log(
      `🏦 BEFORE ${fmt(before)}`
    );

    console.log(
      `⛽ MATIC ${ethers.formatEther(matic)}`
    );

    if (DRY_RUN) {

      console.log(
        "\n📝 DRY RUN ENABLED"
      );

      return;
    }

    const gas =
      await getGasSettings();

    const tx =
      await arb.executeBestFlashLoanArbitrage(
        signal.route.buy,
        signal.route.sell,
        [signal.size],
        signal.route.buyPath,
        signal.route.sellPath,
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
      `📡 TX ${tx.hash}`
    );

    const receipt =
      await tx.wait();

    const after =
      await getVaultBalance();

    const net =
      after - before;

    console.log(
      `\n✅ BLOCK ${receipt.blockNumber}`
    );

    console.log(
      `💰 BEFORE ${fmt(before)}`
    );

    console.log(
      `💰 AFTER ${fmt(after)}`
    );

    console.log(
      `📈 NET PROFIT ${fmt(net)}`
    );

    console.log(
      "\n🏦 PROFITS ACCUMULATED IN CONTRACT"
    );

  } catch (e) {

    console.log(
      `❌ EXECUTION FAILED ${e.message}`
    );

    await rotateRPC();

  } finally {

    EXECUTION_LOCK.active = false;
  }
}

/* =========================================================
   WORKER LOOP
========================================================= */

let tokenIndex = 0;

async function worker(id) {

  const tokens =
    Object.keys(TOKENS)
      .filter(t => t !== "USDC");

  while (true) {

    try {

      const token =
        tokens[
          tokenIndex++
          % tokens.length
        ];

      console.log(
        `\n👷 WORKER ${id}`
      );

      const signal =
        await runDepthAnalysis(
          token
        );

      if (signal) {

        console.log(
          "\n🏆 BEST SIGNAL"
        );

        console.log(
          `TOKEN ${signal.token}`
        );

        console.log(
          `PROFIT ${fmt(signal.estimatedProfit)}`
        );

        console.log(
          `SIZE ${fmt(signal.size)}`
        );

        await execute(signal);
      }

    } catch (e) {

      console.log(
        `❌ WORKER ERROR ${e.message}`
      );
    }

    await sleep(LOOP_DELAY);
  }
}

/* =========================================================
   MAIN
========================================================= */

async function main() {

  console.log(
    "\n🚀 INSTITUTIONAL LIQUIDITY ENGINE STARTED"
  );

  const owner =
    await arb.owner();

  console.log(
    `👤 OWNER ${owner}`
  );

  console.log(
    `👤 WALLET ${wallet.address}`
  );

  const usdc =
    await getVaultBalance();

  const matic =
    await getMaticBalance();

  console.log(
    `🏦 CONTRACT USDC ${fmt(usdc)}`
  );

  console.log(
    `⛽ CONTRACT MATIC ${ethers.formatEther(matic)}`
  );

  console.log(
    `🌐 RPC ${RPCS[rpcIndex]}`
  );

  console.log(
    `👷 WORKERS ${WORKERS}`
  );

  console.log(
    `🧠 MULTI-DEX ARBITRAGE ENABLED`
  );

  await Promise.all(
    Array.from(
      { length: WORKERS },
      (_, i) => worker(i + 1)
    )
  );
}

main().catch(console.error);
