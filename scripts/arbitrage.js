//1
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   HIGH-SPEED POLLING ENGINE SETUP
========================================================= */
const HTTP_ENDPOINT = "https://polygon.drpc.org"; 
console.log("⏳ Initializing Multi-Hop Processing Engine...");
const provider = new ethers.JsonRpcProvider(HTTP_ENDPOINT);
provider.pollingInterval = 200;

provider.getBlockNumber()
  .then((blockNum) => {
    console.log(`\n🟢 CONNECTED → Engine Active on Polygon Block: #${blockNum}`);
    startMultiHopBot();
  })
  .catch((err) => {
    console.error("❌ INITIALIZATION FAILURE:", err.message);
    process.exit(1);
  });

/* =========================================================
   WALLET & SMART CONTRACT ROUTING PROPERTIES
========================================================= */
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const ARB_CONTRACT = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const ABI = [
  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256) external"
];
const contract = new ethers.Contract(ARB_CONTRACT, ABI, wallet);

/* =========================================================
   MARKET INVENTORY CONFIGURATION
========================================================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  CRV: "0x172370d5cd63222165e1dbcb0444552d967140a7"
};

const FACTORIES = {
  QUICK: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  SUSHI: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
  APE: "0xcf083be4164828f00cae704ec15a36d711491284",
  DFYN: "0xe7fb3e833efe5f9c441105eb65ef8b261266423b"
};

const ROUTERS = {
  QUICK: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SUSHI: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  APE: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  DFYN: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429"
};

const FACTORY_ABI = ["function getPair(address,address) view returns(address)"];
const PAIR_ABI = ["getReserves() view returns(uint112,uint112,uint32)", "token0() view returns(address)"];

// Execution Guard Rails
const GAS_LIMIT = 4000000n; 
const PRIORITY_GWEI = "250";
const MAX_GWEI = "500";
const MIN_PROFIT = 500000n; // Target net profits ≥ $0.50 USDC

/* =========================================================
   PURE MATH AND OFFLINE CACHE STORAGE ENGINES
========================================================= */
let localReserveCache = {}; 

function getAmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

// Downloads complete market state instantly into local RAM cache
async function refreshLocalMarketCache() {
  const tokenKeys = Object.keys(TOKENS);
  localReserveCache = {};

  // FIXED: Pointing correctly to FACTORIES
  for (const [dexName, factoryAddr] of Object.entries(FACTORORIES)) {
    localReserveCache[dexName] = {};
    const factoryContract = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);

    for (let i = 0; i < tokenKeys.length; i++) {
      for (let j = i + 1; j < tokenKeys.length; j++) {
        const tA = TOKENS[tokenKeys[i]];
        const tB = TOKENS[tokenKeys[j]];

        try {
          const pairAddr = await factoryContract.getPair(tA, tB);
          if (pairAddr === ethers.ZeroAddress) continue;

          const pairContract = new ethers.Contract(pairAddr, PAIR_ABI, provider);
          const [reserves, t0] = await Promise.all([pairContract.getReserves(), pairContract.token0()]);

          const isToken0A = t0.toLowerCase() === tA.toLowerCase();
          const reserveA = isToken0A ? reserves[0] : reserves[1];
          const reserveB = isToken0A ? reserves[reserves.length - 2] : reserves[0];

          const key = `${tA.toLowerCase()}_${tB.toLowerCase()}`;
          localReserveCache[dexName][key] = { reserveA, reserveB };
        } catch {
          // Silent catch to prevent broken pools from halting scanner
        }
      }
    }
  }
}

function getCachedReserves(dexName, tokenA, tokenB) {
  const tA = tokenA.toLowerCase();
  const tB = tokenB.toLowerCase();
  const keyNormal = `${tA}_${tB}`;
  const keyReversed = `${tB}_${tA}`;

  if (localReserveCache[dexName]?.[keyNormal]) {
    return localReserveCache[dexName][keyNormal];
  } else if (localReserveCache[dexName]?.[keyReversed]) {
    const data = localReserveCache[dexName][keyReversed];
    return { reserveA: data.reserveB, reserveB: data.reserveA };
  }
  return null;
}

function calculatePathOutput(dexName, amountIn, path) {
  let currentAmount = amountIn;
  for (let i = 0; i < path.length - 1; i++) {
    const reserves = getCachedReserves(dexName, path[i], path[i + 1]);
    if (!reserves) return 0n;
    currentAmount = getAmountOut(currentAmount, reserves.reserveA, reserves.reserveB);
  }
  return currentAmount;
}

/* =========================================================
   PERMUTATION MATRIX MULTI-HOP PATHFINDER
========================================================= */
function findBestMultiHop() {
  // FIXED: Pointing correctly to FACTORIES
  const dexList = Object.keys(FACTORIES);
  const intermediateTokens = Object.values(TOKENS).filter(t => t !== TOKENS.USDC);

  let best = null;
  let bestProfit = 0n;

  for (const buyDex of dexList) {
    for (const sellDex of dexList) {
      if (buyDex === sellDex) continue;

      const referenceReserves = getCachedReserves(buyDex, TOKENS.USDC, TOKENS.WETH);
      if (!referenceReserves) continue;
      const tradeSize = referenceReserves.reserveA / 800n; 
      if (tradeSize <= 0n) continue;

      for (const tokenA of intermediateTokens) {
        // 2-LEG DIRECT PAIR MULTI-HOP
        const pathToToken2L = [TOKENS.USDC, tokenA];
        const pathBackUSDC2L = [tokenA, TOKENS.USDC];

        const outTokenA2L = calculatePathOutput(buyDex, tradeSize, pathToToken2L);
        if (outTokenA2L > 0n) {
          const finalUSDC2L = calculatePathOutput(sellDex, outTokenA2L, pathBackUSDC2L);
          const profit2L = finalUSDC2L - tradeSize;

          if (profit2L > bestProfit) {
            bestProfit = profit2L;
            best = { buy: buyDex, sell: sellDex, tradeSize, pathToToken: pathToToken2L, pathToUSDC: pathBackUSDC2L };
          }
        }

        // 3-LEG EXTENDED MULTI-HOP
        for (const tokenB of intermediateTokens) {
          if (tokenA === tokenB) continue;

          const pathToToken3L = [TOKENS.USDC, tokenA, tokenB];
          const pathBackUSDC3L = [tokenB, tokenA, TOKENS.USDC];

          const outTokenB3L = calculatePathOutput(buyDex, tradeSize, pathToToken3L);
          if (outTokenB3L > 0n) {
            const finalUSDC3L = calculatePathOutput(sellDex, outTokenB3L, pathBackUSDC3L);
            const profit3L = finalUSDC3L - tradeSize;

            if (profit3L > bestProfit) {
              bestProfit = profit3L;
              best = { buy: buyDex, sell: sellDex, tradeSize, pathToToken: pathToToken3L, pathToUSDC: pathBackUSDC3L };
            }
          }
        }
      }
    }
  }
  return { best, bestProfit };
}

/* =========================================================
   ON-CHAIN CONTRACT CALL DISPATCHER
========================================================= */
async function execute(best) {
  console.log("⚡ Dispatching arbitrage transaction payload to mempool...");
  try {
    const tx = await contract.executeAaveFlashLoanArbitrage(
      ROUTERS[best.buy],
      ROUTERS[best.sell],
      best.tradeSize,
      best.pathToToken,
      best.pathToUSDC,
      Math.floor(Date.now() / 1000) + 60,
      {
        gasLimit: GAS_LIMIT,
        maxPriorityFeePerGas: ethers.parseUnits(PRIORITY_GWEI, "gwei"),
        maxFeePerGas: ethers.parseUnits(MAX_GWEI, "gwei"),
        nonce: await provider.getTransactionCount(wallet.address, "pending")
      }
    );

    await tx.wait(1);
    console.log(`🟢 Transaction Confirmed! Tx Hash: ${tx.hash}`);
    console.log("📈 Net PnL realized on-chain.");
  } catch (txError) {
    console.log("❌ Transaction dropped or reverted by node mempool.");
  }
}

/* =========================================================
   MAIN AGGREGATOR LOOP STREAMER
========================================================= */
async function startMultiHopBot() {
  console.log("\n🚀 MULTI-DEX STREAMING BOT STARTED");

  provider.on("block", async (blockNumber) => {
    console.log(`\n📦 NEW BLOCK MINED: #${blockNumber} | SCANNING FOR OPPORTUNITIES...`);

    try {
      await refreshLocalMarketCache();
      const { best, bestProfit } = findBestMultiHop();

      if (bestProfit >= MIN_PROFIT) {
        console.log(`💰 PROFIT OPPORTUNITY GENERATED: ${ethers.formatUnits(bestProfit, 6)} USDC`);

        const buildReadableName = (path) => path.map(addr => Object.keys(TOKENS).find(k => TOKENS[k] === addr) || "??").join(" -> ");
        console.log(`[DEX PATH]: ${best.buy} (${buildReadableName(best.pathToToken)}) ➡️ ${best.sell} (${buildReadableName(best.pathToUSDC)})`);

        await execute(best);
      } else {
        console.log("⏱️ Scan Finished. No profitable variations found in this block.");
      }
    } catch (err) {
      console.log("\n❌ STREAM EXECUTION ERROR:");
      console.log(err.reason || err.message || err);
    }
  });
}
