import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   HIGH-SPEED POLLING ENGINE SETUP (NO REGISTRATION)
========================================================= */
const HTTP_ENDPOINT = "https://polygon.drpc.org"; // Fast, resilient public endpoint

console.log("⏳ Initializing High-Speed Provider Engine...");
const provider = new ethers.JsonRpcProvider(HTTP_ENDPOINT);

// Force the engine to query the network every 200ms instead of standard 4-second defaults
provider.pollingInterval = 200;

// Instantly test connection capability and fire up the bot
provider.getBlockNumber()
  .then((blockNum) => {
    console.log(`🟢 CONNECTED TO ENGINE → Current Polygon Block: #${blockNum}`);
    startStreamingBot();
  })
  .catch((err) => {
    console.error("❌ CONNECTION FAILURE:", err.message);
    process.exit(1);
  });

/* =========================================================
   WALLET & ARBITRAGE SMART CONTRACT CONFIGURATION
========================================================= */
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const ARB_CONTRACT = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";
const ABI = [
  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256) external",
  "function setMinimumProfitUSDC(uint256) external",
  "function minimumProfitUSDC() view returns(uint256)"
];

const contract = new ethers.Contract(ARB_CONTRACT, ABI, wallet);

/* =========================================================
   TOKENS & DEX LIST ROUTING CONFIGURATION
========================================================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
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
const PAIR_ABI = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];

/* =========================================================
   GAS & EXECUTION PROPERTIES
========================================================= */
const GAS_LIMIT = 3000000n;
const PRIORITY_GWEI = "120";
const MAX_GWEI = "300";
const MIN_PROFIT = 1n; // Tracks raw micro-USDC differences

/* =========================================================
   PRICING UTILITIES & MATHEMATICAL EQUATIONS
========================================================= */
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

async function getReserves(factoryAddr, tokenA, tokenB) {
  try {
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
    const pairAddr = await factory.getPair(tokenA, tokenB);
    if (pairAddr === ethers.ZeroAddress) return null;

    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const reserves = await pair.getReserves();
    const token0 = await pair.token0();

    if (token0.toLowerCase() === tokenA.toLowerCase()) {
      return { reserveA: reserves[0], reserveB: reserves[1] };
    } else {
      return { reserveA: reserves[1], reserveB: reserves[0] };
    }
  } catch {
    return null;
  }
}

async function simulatePath(factoryAddr, amountIn, path) {
  let currentAmount = amountIn;
  for (let i = 0; i < path.length - 1; i++) {
    const reserves = await getReserves(factoryAddr, path[i], path[i + 1]);
    if (!reserves) return null;
    currentAmount = getAmountOut(currentAmount, reserves.reserveA, reserves.reserveB);
  }
  return currentAmount;
}

/* =========================================================
   OPPORTUNITY AGGREGATOR CALCULATOR
========================================================= */
async function findBest() {
  const dexList = Object.entries(FACTORIES);
  const tokens = Object.values(TOKENS).filter(t => t !== TOKENS.USDC);
  const hopTokens = [TOKENS.WETH, TOKENS.WMATIC];

  let best = null;
  let bestProfit = 0n;

  for (const [nameA, factoryA] of dexList) {
    for (const [nameB, factoryB] of dexList) {
      if (nameA === nameB) continue;

      for (const token of tokens) {
        const reserves = await getReserves(factoryA, TOKENS.USDC, token);
        if (!reserves) continue;

        const tradeSize = reserves.reserveA / 1000n;
        if (tradeSize <= 0n) continue;

        // DIRECT MATCH SIMULATION
        const directPath = [TOKENS.USDC, token];
        const tokenOut = await simulatePath(factoryA, tradeSize, directPath);
        if (!tokenOut) continue;

        const usdcBack = await simulatePath(factoryB, tokenOut, [token, TOKENS.USDC]);
        if (!usdcBack) continue;

        const profit = usdcBack - tradeSize;
        if (profit > bestProfit) {
          bestProfit = profit;
          best = {
            buy: nameA,
            sell: nameB,
            tradeSize,
            token,
            pathToToken: directPath,
            pathToUSDC: [token, TOKENS.USDC],
            isHop: false
          };
        }

        // HOP ROUTE SIMULATION
        for (const hop of hopTokens) {
          if (hop === token) continue;

          const buyPath = [TOKENS.USDC, hop, token];
          const sellPath = [token, hop, TOKENS.USDC];

          const hopOut = await simulatePath(factoryA, tradeSize, buyPath);
          if (!hopOut) continue;

          const hopBack = await simulatePath(factoryB, hopOut, sellPath);
          if (!hopBack) continue;

          const hopProfit = hopBack - tradeSize;
          if (hopProfit > bestProfit) {
            bestProfit = hopProfit;
            best = {
              buy: nameA,
              sell: nameB,
              tradeSize,
              token,
              pathToToken: buyPath,
              pathToUSDC: sellPath,
              isHop: true
            };
          }
        }
      }
    }
  }
  return { best, bestProfit };
}

/* =========================================================
   TRANSACTION SUBMISSION HANDLER
========================================================= */
async function execute(best) {
  try {
    const minimum = await contract.minimumProfitUSDC();
    if (minimum > 0n) {
      const tx = await contract.setMinimumProfitUSDC(0);
      await tx.wait();
    }
  } catch (err) {}

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
   MAIN BOT ENGINE STREAM EVENT LISTENER
========================================================= */
async function startStreamingBot() {
  console.log("\n🚀 MULTI-DEX STREAMING BOT STARTED");

  provider.on("block", async (blockNumber) => {
    console.log(`\n📦 NEW BLOCK MINED: #${blockNumber} | SCANNING FOR OPPORTUNITIES...`);

    try {
      const { best, bestProfit } = await findBest();

      if (bestProfit >= MIN_PROFIT) {
        console.log(`💰 PROFIT OPPORTUNITY GENERATED: ${ethers.formatUnits(bestProfit, 6)} USDC`);
        
        const tokenName = Object.keys(TOKENS).find(key => TOKENS[key] === best.token) || "UNKNOWN";
        console.log(`[DEX PATH]: ${best.buy} (USDC -> ${tokenName}) ➡️ ${best.sell} (${tokenName} -> USDC)`);
        
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
