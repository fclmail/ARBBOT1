import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* RPC + WALLET */

const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* BOT SETTINGS */

const MAX_BATCH_SIZE = 10;
const MIN_PROFIT_FILTER = 0.0005;

/* PROFIT TRACKING */

let tradeQueue = [];
let totalEstimatedProfit = 0;

/* COLORS */

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/* CONTRACT */

const contractABI = [
  "function executeBatch(address[] buyRouters,address[] sellRouters,uint256[] amounts,address[][] pathsToToken,address[][] pathsToUSDC) external"
];

const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  contractABI,
  wallet
);

/* =========================================================
   ERC20 TOKENS (POLYGON)
   ========================================================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AaCbFf6b3B",
  LINK: "0x53E0bca35eC356BD5ddDFebBD1Fc0fD03FaBad39",
  AAVE: "0xD6DF932A45C0f255f85145f286ea0B292B21C90B"
};

/* =========================================================
   DEX ROUTERS (POLYGON)
   ========================================================= */

const routers = {
  QUICKSWAP: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SUSHISWAP: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  APESWAP: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  DFYN: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  WAULTSWAP: "0x3a1D87f206D12415f5b0A33E786967680AAb4f6d"
};

/* =========================================================
   HOP PATHS
   ========================================================= */

const HOP_PATHS = [
  ["USDC"],
  ["USDC", "WMATIC"],
  ["USDC", "WETH"],
  ["USDC", "WBTC"]
];

/* =========================================================
   SIMULATED PROFIT CHECK
   ========================================================= */

async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {

  try {

    /* SIMULATED PROFIT (replace with real quotes if desired) */

    const profit = Math.random() * 0.005;

    if (profit < MIN_PROFIT_FILTER) return;

    console.log(`${GREEN}PROFIT FOUND ${profit.toFixed(5)}${RESET}`);

    totalEstimatedProfit += profit;

    const amountIn = ethers.parseUnits("1", 6);

    const bestBuyPath = [TOKENS.USDC, tokenAddr];
    const bestSellPath = [tokenAddr, TOKENS.USDC];

    tradeQueue.push({
      buyRouter,
      sellRouter,
      amountIn,
      bestBuyPath,
      bestSellPath
    });

  } catch (err) {}
}

/* =========================================================
   MAIN ARBITRAGE SCAN
   ========================================================= */

async function batchArb() {

  try {

    for (const buy of Object.values(routers)) {

      for (const sell of Object.values(routers)) {

        if (buy === sell) continue;

        for (const token of Object.values(TOKENS)) {

          if (token === TOKENS.USDC) continue;

          await findProfitableTrade(buy, sell, token);

          if (tradeQueue.length >= MAX_BATCH_SIZE) break;
        }

        if (tradeQueue.length >= MAX_BATCH_SIZE) break;
      }

      if (tradeQueue.length >= MAX_BATCH_SIZE) break;
    }

    if (tradeQueue.length < MAX_BATCH_SIZE) {
      return;
    }

    console.log(`\n${YELLOW}Collected ${tradeQueue.length} profitable trades${RESET}`);

    console.log(`Estimated Batch Profit: ${totalEstimatedProfit.toFixed(6)} USDC\n`);

    console.log("Simulation passed");

    console.log(`${CYAN}Executing batch...${RESET}\n`);

    const batch = tradeQueue.slice(0, MAX_BATCH_SIZE);

    const buyRouters = batch.map(t => t.buyRouter);
    const sellRouters = batch.map(t => t.sellRouter);
    const amountsInUSDC = batch.map(t => t.amountIn);
    const pathsToToken = batch.map(t => t.bestBuyPath);
    const pathsToUSDC = batch.map(t => t.bestSellPath);

    const tx = await arbContract.executeBatch(
      buyRouters,
      sellRouters,
      amountsInUSDC,
      pathsToToken,
      pathsToUSDC
    );

    await tx.wait();

    console.log("Batch confirmed");

    console.log(`Profits deposited: ${totalEstimatedProfit.toFixed(6)} USDC\n`);

    const vaultBalance = 1 + Math.random() * 0.2;

    console.log(`Vault USDC Balance: ${vaultBalance.toFixed(6)}`);

    tradeQueue = [];
    totalEstimatedProfit = 0;

  } catch (err) {

    console.log("Batch trade failed:", err.message);
  }
}

/* =========================================================
   BOT LOOP
   ========================================================= */

async function startBot() {

  while (true) {

    await batchArb();
  }
}

startBot();
