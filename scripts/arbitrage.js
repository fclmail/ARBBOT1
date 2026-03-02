import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */
dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */
const MIN_EXPECTED_PROFIT = 0.000001;
const SCAN_INTERVAL_MS = 1000;
const DEADLINE_SECONDS = 200;
const MIN_TRADE_USDC = 0.02;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";

const vaultAbi = [
  {
    name: "executeFlashBatchArbitrage",
    type: "function",
    inputs: [
      { name: "buyRouters", type: "address[]" },
      { name: "sellRouters", type: "address[]" },
      { name: "amountsInUSDC", type: "uint256[]" },
      { name: "pathsToToken", type: "address[][]" },
      { name: "pathsToUSDC", type: "address[][]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= USDC ================= */
const usdcAbi = ["function balanceOf(address owner) view returns (uint256)"];

const usdc = new ethers.Contract(
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  usdcAbi,
  provider
);

/* ================= AAVE ================= */
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

const aaveAbi = [
  "function getReserveData(address asset) view returns (tuple(uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint8 id))"
];

const aave = new ethers.Contract(AAVE_POOL, aaveAbi, provider);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAaveLiquidity() {
  try {
    const reserve = await aave.getReserveData(TOKENS.USDC);

    const aToken = new ethers.Contract(
      reserve.aTokenAddress,
      ["function totalSupply() view returns (uint256)"],
      provider
    );

    const liquidity = await aToken.totalSupply();
    console.log(`${CYAN}Aave pool:${RESET} ${ethers.formatUnits(liquidity,6)}`);
    return liquidity;
  } catch {
    return 0n;
  }
}

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= SCALE ================= */
async function scaleAmount(baseAmount) {
  const vaultBalance = await usdc.balanceOf(VAULT_ADDRESS);
  const poolLiquidity = await getAaveLiquidity();

  const multipliers = [1n,2n,4n,8n,16n,32n];
  let maxAmount = baseAmount;

  for (const m of multipliers) {
    const scaled = baseAmount * m;
    if (scaled > vaultBalance + poolLiquidity) break;
    maxAmount = scaled;
  }

  console.log(`${YELLOW}Max Amount Found:${RESET} ${ethers.formatUnits(maxAmount,6)}`);
  return maxAmount;
}

/* ================= ARB ================= */
async function findTrade(buyRouter, sellRouter, tokenAddr) {

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  /* FULL BUY PATHS */
  const buyPaths = [
    [TOKENS.USDC, tokenAddr],
    [TOKENS.USDC, TOKENS.WMATIC, tokenAddr],
    [TOKENS.USDC, TOKENS.WETH, tokenAddr],
    [TOKENS.USDC, TOKENS.USDT, tokenAddr],
    [TOKENS.USDC, TOKENS.DAI, tokenAddr]
  ];

  let bestBuyOut, bestBuyPath;

  for (const path of buyPaths) {
    const out = await quote(buyRouter, amountIn, path);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = path;
    }
  }

  if (!bestBuyOut) return null;

  /* FULL SELL PATHS */
  const sellPaths = [
    [tokenAddr, TOKENS.USDC],
    [tokenAddr, TOKENS.WMATIC, TOKENS.USDC],
    [tokenAddr, TOKENS.WETH, TOKENS.USDC],
    [tokenAddr, TOKENS.USDT, TOKENS.USDC],
    [tokenAddr, TOKENS.DAI, TOKENS.USDC]
  ];

  let bestSellOut, bestSellPath;

  for (const path of sellPaths) {
    const out = await quote(sellRouter, bestBuyOut, path);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = path;
    }
  }

  if (!bestSellOut) return null;

  const profitRaw = bestSellOut - amountIn;
  const profit = Number(ethers.formatUnits(profitRaw,6));

  if (profit < MIN_EXPECTED_PROFIT) return null;

  console.log(`${GREEN}Profit Found:${RESET}${profit}`);
  console.log(`${CYAN}Trade amount:${RESET}${MIN_TRADE_USDC}`);

  return {
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath
  };
}

/* ================= EXECUTE ================= */
async function batchArb() {

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;

      for (const token of Object.values(TOKENS)) {

        const trade = await findTrade(buy, sell, token);
        if (!trade) continue;

        const scaledAmount = await scaleAmount(trade.amountIn);
        const deadline = Math.floor(Date.now()/1000)+DEADLINE_SECONDS;

        try {

          await vault.executeFlashBatchArbitrage.staticCall(
            [trade.buyRouter],
            [trade.sellRouter],
            [scaledAmount],
            [trade.bestBuyPath],
            [trade.bestSellPath],
            deadline
          );

          console.log(`${GREEN}Simulation pass${RESET}`);

          const gas = await vault.executeFlashBatchArbitrage.estimateGas(
            [trade.buyRouter],
            [trade.sellRouter],
            [scaledAmount],
            [trade.bestBuyPath],
            [trade.bestSellPath],
            deadline
          );

          console.log(`${CYAN}Gas estimate:${RESET}${gas}`);

          const tx = await vault.executeFlashBatchArbitrage(
            [trade.buyRouter],
            [trade.sellRouter],
            [scaledAmount],
            [trade.bestBuyPath],
            [trade.bestSellPath],
            deadline,
            { gasLimit: (gas*120n)/100n }
          );

          console.log(`${GREEN}Executing:${RESET}${tx.hash}`);
          await tx.wait();

          console.log(`${GREEN}Profit deposited to vault${RESET}`);

        } catch (err) {
          console.log(`${RED}Execution failed:${RESET}`, err?.reason || err?.message);
        }

        return;
      }
    }
  }

  console.log("No profitable trades found");
}

/* ================= LOOP ================= */
async function main() {
  while(true){
    await batchArb();
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
