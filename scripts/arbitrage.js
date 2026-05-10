import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PK");

/* ================= CONFIG ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const MODE = process.env.MODE || "VAULT";
const MIN_PROFIT_USDC = process.env.MIN_PROFIT || "0.0004";

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS = "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const contractAbi = [
  "function triggerFlashArbitrage((address routerBuy,address routerSell,address token) route,uint256 amountIn,uint256 minimumExpectedProfit)",
  "function startAaveFlashArbitrage(address asset,uint256 amount,(address routerBuy,address routerSell,address token) route,uint256 minProfit)",
  "function findBestFlashLoanSize(address buyRouter,address sellRouter,uint256[] candidateSizes,address[] pathToToken,address[] pathToUSDC) view returns(tuple(uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",
  "function getContractUSDCBalance() view returns(uint256)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

/* ================= ROUTERS ================= */

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= TOKENS ================= */

const TOKENS = {

  USDC:  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH:  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC:  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  DAI:   "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT:  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"

};

/* ================= ROUTE BUILDER ================= */

function makeRoute(token, intermediate = null) {

  if (intermediate) {

    return {
      buyRouter: QUICKSWAP_ROUTER,
      sellRouter: SUSHISWAP_ROUTER,
      pathToToken: [TOKENS.USDC, intermediate, token],
      pathToUSDC: [token, intermediate, TOKENS.USDC],
      deadline: Math.floor(Date.now() / 1000) + 60
    };

  }

  return {
    buyRouter: QUICKSWAP_ROUTER,
    sellRouter: SUSHISWAP_ROUTER,
    pathToToken: [TOKENS.USDC, token],
    pathToUSDC: [token, TOKENS.USDC],
    deadline: Math.floor(Date.now() / 1000) + 60
  };

}

/* ================= HELPERS ================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ================= PROFIT WEIGHTED SCALING ================= */

async function profitWeightedSize(
  buyRouter,
  sellRouter,
  candidateSizes,
  pathToToken,
  pathToUSDC,
  maxLoan
) {

  const result = await vault.findBestFlashLoanSize(
    buyRouter,
    sellRouter,
    candidateSizes,
    pathToToken,
    pathToUSDC
  );

  const amountIn = BigInt(result.amountIn);
  const profit = BigInt(result.estimatedProfit);

  if (profit === 0n) {
    return { size: 0n, profit: 0n };
  }

  const efficiency = (profit * 1_000_000n) / amountIn;

  let multiplier = 100n;

  if (efficiency > 2000n) multiplier = 300n;
  else if (efficiency > 1000n) multiplier = 200n;
  else if (efficiency > 500n) multiplier = 150n;

  const scaled = (amountIn * multiplier) / 100n;
  const finalSize = scaled < BigInt(maxLoan) ? scaled : BigInt(maxLoan);

  console.log(
    `  📐 Amount ${ethers.formatUnits(amountIn,6)} | Efficiency ${efficiency} | Multiplier ${multiplier/100n}x`
  );

  return {
    size: finalSize,
    profit
  };
}

/* ================= MICRO DETECTION ================= */

async function microDetect() {

  console.log("🔎 Multi-hop scanning...");

  const tokens = Object.entries(TOKENS).filter(
    ([k]) => k !== "USDC"
  );

  const INTERMEDIATES = [
    TOKENS.USDT,
    TOKENS.DAI,
    TOKENS.WMATIC,
    TOKENS.WETH,
    TOKENS.WBTC
  ];

  const candidateSizes = [

    ethers.parseUnits("1000",6),
    ethers.parseUnits("5000",6),
    ethers.parseUnits("10000",6),
    ethers.parseUnits("25000",6),
    ethers.parseUnits("50000",6),
    ethers.parseUnits("100000",6)

  ];

  const maxLoan = ethers.parseUnits("100000",6);

  let best = {
    profit: 0n
  };

  for (const [name, token] of tokens) {

    for (const intermediate of INTERMEDIATES) {

      if (token === intermediate) continue;

      const route = makeRoute(token, intermediate);

      try {

        const result = await profitWeightedSize(
          route.buyRouter,
          route.sellRouter,
          candidateSizes,
          route.pathToToken,
          route.pathToUSDC,
          maxLoan
        );

        console.log(
          `   ${name} via ${intermediate.slice(0,6)} profit: ${ethers.formatUnits(result.profit,6)}`
        );

        if (result.profit > best.profit) {

          best = {
            token,
            size: result.size,
            profit: result.profit,
            route
          };

        }

      } catch {}

    }

  }

  if (best.profit === 0n) {
    console.log("⚠️ No profitable route");
  } else {
    console.log(
      `🏆 Best profit: ${ethers.formatUnits(best.profit,6)}`
    );
  }

  return best;
}

/* ================= EXECUTION ================= */

async function execute(route, token, size) {

  const vaultBalance = BigInt(await vault.getContractUSDCBalance());

  console.log(
    `💰 Vault Balance: ${ethers.formatUnits(vaultBalance,6)} USDC`
  );

  if (MODE === "VAULT") {

    const finalSize = size > vaultBalance ? vaultBalance : size;

    if (finalSize === 0n) {
      console.log("❌ No vault funds");
      return;
    }

    const tx = await vault.triggerFlashArbitrage(
      {
        routerBuy: route.buyRouter,
        routerSell: route.sellRouter,
        token
      },
      finalSize,
      ethers.parseUnits("0.000001",6)
    );

    console.log("TX:", tx.hash);

    const receipt = await tx.wait();

    console.log("Confirmed:", receipt.blockNumber);

    return receipt;
  }

  if (MODE === "FLASH") {

    const tx = await vault.startAaveFlashArbitrage(
      TOKENS.USDC,
      size,
      {
        routerBuy: route.buyRouter,
        routerSell: route.sellRouter,
        token
      },
      ethers.parseUnits("0.000001",6)
    );

    console.log("TX:", tx.hash);

    return await tx.wait();
  }

}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log("🚀 BOT STARTED");

  let cycle = 0;

  while (true) {

    cycle++;

    console.log(`\n--- Cycle ${cycle} ---`);

    try {

      const signal = await microDetect();

      const minProfit = ethers.parseUnits(MIN_PROFIT_USDC,6);

      if (signal.profit > minProfit) {

        console.log("🔥 EXECUTING");

        await execute(
          signal.route,
          signal.token,
          signal.size
        );

      } else {

        console.log(
          `💤 No trade (${ethers.formatUnits(signal.profit,6)})`
        );

      }

    } catch (err) {

      console.log("Error:", err.message);

    }

    await sleep(2000);

  }

}

main();
