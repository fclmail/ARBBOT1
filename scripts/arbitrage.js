import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE KEY");
}

/* =========================================================
   PROVIDER
========================================================= */

const RPC =
  "https://polygon-bor-rpc.publicnode.com";

const provider =
  new ethers.JsonRpcProvider(RPC);

const wallet =
  new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

/* =========================================================
   CONTRACT
========================================================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const arbAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)"
];

const vault =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    arbAbi,
    wallet
  );

/* =========================================================
   ROUTER ABI
========================================================= */

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
];

/* =========================================================
   ERC20 ABI
========================================================= */

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)"
];

/* =========================================================
   TOKENS
========================================================= */

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const WMATIC =
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const WETH =
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const LINK =
  ethers.getAddress(
    "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
  );

const WBTC =
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";

const DAI =
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";

const CRV =
  "0x172370d5Cd63279eFa6d502DAB29171933a610AF";

/* =========================================================
   OPTIONAL VOLATILE TOKENS
========================================================= */

const AAVE =
  "0xD6DF932A45C0f255f85145f286ea0B292B21C90B";

const SUSHI_TOKEN =
  "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a";

/* =========================================================
   USDC CONTRACT
========================================================= */

const usdc =
  new ethers.Contract(
    USDC,
    erc20Abi,
    provider
  );

/* =========================================================
   ROUTERS
========================================================= */

const QUICK =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

const SUSHI =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const DFYN =
  "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429";

const WAULT =
  "0x3a1D87f206D12415f5b0A33E786967680AAb4f6d";

const APESWAP =
  "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607";

const JETSWAP =
  "0x5C6Ec38A8E5fA9Da1bD36A8b6D3d4fD4c3E9d0dE";

const CAFESWAP =
  "0x9055682E58C74fc8DdBFC55Ad2428aB1F96098Fc";

const quickRouter =
  new ethers.Contract(
    QUICK,
    routerAbi,
    provider
  );

const sushiRouter =
  new ethers.Contract(
    SUSHI,
    routerAbi,
    provider
  );

const dfynRouter =
  new ethers.Contract(
    DFYN,
    routerAbi,
    provider
  );

const waultRouter =
  new ethers.Contract(
    WAULT,
    routerAbi,
    provider
  );

const apeRouter =
  new ethers.Contract(
    APESWAP,
    routerAbi,
    provider
  );

const jetRouter =
  new ethers.Contract(
    JETSWAP,
    routerAbi,
    provider
  );

const cafeRouter =
  new ethers.Contract(
    CAFESWAP,
    routerAbi,
    provider
  );

const DEXES = [
  {
    name: "QUICKSWAP",
    address: QUICK,
    router: quickRouter
  },
  {
    name: "SUSHISWAP",
    address: SUSHI,
    router: sushiRouter
  },
  {
    name: "DFYN",
    address: DFYN,
    router: dfynRouter
  },
  {
    name: "WAULT",
    address: WAULT,
    router: waultRouter
  },
  {
    name: "APESWAP",
    address: APESWAP,
    router: apeRouter
  },
  {
    name: "JETSWAP",
    address: JETSWAP,
    router: jetRouter
  },
  {
    name: "CAFESWAP",
    address: CAFESWAP,
    router: cafeRouter
  }
];

/* =========================================================
   SETTINGS
========================================================= */

/*
  LOWERED TRADE SIZE
  Smaller trades create less price impact
*/

const TRADE_AMOUNT =
  ethers.parseUnits("5", 6);

const FLASH_LOAN_FEE_BPS = 9;

const SLIPPAGE_BPS = 100;

const GAS_ESTIMATE = 1001244n;

const LOOP_DELAY = 1000;

/* =========================================================
   ROUTES
========================================================= */

const ROUTES = [
  {
    symbol: "WETH→WBTC",
    pathBuy: [USDC, WMATIC, WETH],
    pathSell: [WETH, WBTC, USDC],
    decimals: 18,
    sellDecimals: 8
  },
  {
    symbol: "WETH→LINK",
    pathBuy: [USDC, WMATIC, WETH],
    pathSell: [WETH, LINK, USDC],
    decimals: 18,
    sellDecimals: 18
  },
  {
    symbol: "DAI→WETH",
    pathBuy: [USDC, WMATIC, DAI],
    pathSell: [DAI, WETH, USDC],
    decimals: 18,
    sellDecimals: 18
  },
  {
    symbol: "WBTC→WETH",
    pathBuy: [USDC, WMATIC, WBTC],
    pathSell: [WBTC, WETH, USDC],
    decimals: 8,
    sellDecimals: 18
  },
  {
    symbol: "LINK→WBTC",
    pathBuy: [USDC, WMATIC, LINK],
    pathSell: [LINK, WBTC, USDC],
    decimals: 18,
    sellDecimals: 8
  },

  /* VOLATILE ROUTES */

  {
    symbol: "AAVE→WETH",
    pathBuy: [USDC, WMATIC, AAVE],
    pathSell: [AAVE, WETH, USDC],
    decimals: 18,
    sellDecimals: 18
  },

  {
    symbol: "SUSHI→WETH",
    pathBuy: [USDC, WMATIC, SUSHI_TOKEN],
    pathSell: [SUSHI_TOKEN, WETH, USDC],
    decimals: 18,
    sellDecimals: 18
  }
];

/* =========================================================
   HELPERS
========================================================= */

const fmt = (v, d = 6) =>
  Number(
    ethers.formatUnits(v, d)
  ).toFixed(6);

const sleep = (ms) =>
  new Promise((r) =>
    setTimeout(r, ms)
  );

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/* =========================================================
   BALANCES
========================================================= */

async function getBalances() {

  const walletUSDC =
    await usdc.balanceOf(
      wallet.address
    );

  const contractUSDC =
    await usdc.balanceOf(
      CONTRACT_ADDRESS
    );

  const walletMatic =
    await provider.getBalance(
      wallet.address
    );

  return {
    walletUSDC,
    contractUSDC,
    walletMatic
  };
}

/* =========================================================
   SLIPPAGE
========================================================= */

function safeSlippage(rawProfit) {

  const p =
    Math.abs(rawProfit) *
    (SLIPPAGE_BPS / 10000);

  return Math.max(
    p,
    0.001
  );
}

/* =========================================================
   MULTI DEX SCANNER
========================================================= */

async function findBestArb(route) {

  let best = null;

  for (const buyDex of DEXES) {

    try {

      const buyAmounts =
        await buyDex.router.getAmountsOut(
          TRADE_AMOUNT,
          route.pathBuy
        );

      const buyAmt =
        buyAmounts[
          route.pathBuy.length - 1
        ];

      for (const sellDex of DEXES) {

        if (
          sellDex.name === buyDex.name
        ) continue;

        try {

          console.log(
            `🔍 TESTING: ${buyDex.name} → ${sellDex.name}`
          );

          const sellAmounts =
            await sellDex.router.getAmountsOut(
              buyAmt,
              route.pathSell
            );

          const midSellAmount =
            sellAmounts[1];

          const sellAmt =
            sellAmounts[
              route.pathSell.length - 1
            ];

          const buyUSDC =
            Number(fmt(TRADE_AMOUNT));

          const sellUSDC =
            Number(fmt(sellAmt));

          const raw =
            sellUSDC - buyUSDC;

          if (
            !best ||
            raw > best.raw
          ) {

            best = {
              buyDex,
              sellDex,
              buyAmt,
              midSellAmount,
              sellAmt,
              raw
            };

          }

        } catch {}

      }

    } catch {}

  }

  return best;
}

/* =========================================================
   SIMULATION
========================================================= */

async function simulate(batch) {

  try {

    await vault.executeFlashBatchArbitrage.staticCall(
      batch
    );

    return true;

  } catch {

    return false;
  }
}

/* =========================================================
   EXECUTION
========================================================= */

async function execute(
  batch,
  sym,
  profit,
  start,
  arb,
  totalNetProfit,
  totalTrades
) {

  const before =
    await getBalances();

  console.log("====================================================");
  console.log("🔥 EXECUTING FLASH BATCH");
  console.log("====================================================\n");

  console.log("📊 BEFORE BALANCES\n");

  console.log(
    `👛 WALLET USDC:\n  ${fmt(before.walletUSDC)}`
  );

  console.log(
    `🏦 CONTRACT USDC:\n  ${fmt(before.contractUSDC)}`
  );

  console.log(
    `⛽ WALLET MATIC:\n  ${ethers.formatEther(before.walletMatic)}\n`
  );

  const tx =
    await vault.executeFlashBatchArbitrage(
      batch
    );

  console.log("🚀 TX HASH:");
  console.log(tx.hash);

  console.log("\n⚡ TX STATUS:");
  console.log("SENT\n");

  console.log("⏳ WAITING...\n");

  await tx.wait();

  const after =
    await getBalances();

  console.log("📊 AFTER BALANCES\n");

  console.log(
    `👛 WALLET USDC:\n  ${fmt(after.walletUSDC)}`
  );

  console.log(
    `🏦 CONTRACT USDC:\n  ${fmt(after.contractUSDC)}`
  );

  console.log(
    `⛽ WALLET MATIC:\n  ${ethers.formatEther(after.walletMatic)}\n`
  );

  const ms =
    Date.now() - start;

  console.log("====================================================");
  console.log("🏁 FINAL RESULTS");
  console.log("====================================================\n");

  console.log(
    `💰 THIS TRADE:\n  ${profit.toFixed(6)} USDC\n`
  );

  console.log(
    `📊 ACCUMULATED PROFIT:\n  ${fmt(totalNetProfit)} USDC\n`
  );

  console.log(
    `📊 TOTAL TRADES:\n  ${totalTrades}\n`
  );

  console.log(
    `⚡ EXECUTED ROUTE:\n  USDC → ${sym} → USDC\n`
  );

  console.log(
    `⚡ SCAN→EXECUTE:\n  ${ms}ms\n`
  );

  console.log("====================================================\n");
}

/* =========================================================
   MAIN LOOP
========================================================= */

async function main() {

  console.log(
    "\n🚀 MICRO→MACRO ARB ENGINE STARTED\n"
  );

  let totalNetProfit = 0n;
  let totalTrades = 0;

  while (true) {

    console.log(
      "\n🔄 MULTI-ASSET TRIANGULAR SCAN"
    );

    console.log(
      "====================================================\n"
    );

    for (const r of ROUTES) {

      const start =
        Date.now();

      try {

        console.log(
          `📡 SCANNING:\n${r.symbol}`
        );

        const arb =
          await findBestArb(r);

        if (!arb) {
          continue;
        }

        const buyAmt =
          arb.buyAmt;

        const sellAmt =
          arb.sellAmt;

        const buyUSDC =
          Number(fmt(TRADE_AMOUNT));

        const sellUSDC =
          Number(fmt(sellAmt));

        const raw =
          sellUSDC - buyUSDC;

        const gasMatic =
          Number(
            ethers.formatEther(
              GAS_ESTIMATE
            )
          );

        const gas =
          gasMatic * 0.7;

        const fee =
          Number(
            fmt(
              (
                TRADE_AMOUNT *
                BigInt(
                  FLASH_LOAN_FEE_BPS
                )
              ) / 10000n
            )
          );

        const slip =
          safeSlippage(raw);

        const net =
          raw -
          gas -
          fee -
          slip;

        const buySym =
          r.symbol.split("→")[0];

        const sellSym =
          r.symbol.split("→")[1];

        console.log(
          `🔀 DEX ROUTE:\n${arb.buyDex.name} → ${arb.sellDex.name}\n`
        );

        console.log(
          `USDC → ${buySym} → ${sellSym} → USDC\n`
        );

        console.log(
          `💰 BUY:\n  ${buyUSDC.toFixed(2)} USDC → ${fmt(buyAmt, r.decimals)} ${buySym}`
        );

        console.log(
          `💰 SELL:\n  ${fmt(buyAmt, r.decimals)} ${buySym} → ${fmt(arb.midSellAmount, r.sellDecimals)} ${sellSym} → ${sellUSDC.toFixed(2)} USDC\n`
        );

        console.log(
          `📊 RAW PROFIT:\n  ${raw.toFixed(6)} USDC\n`
        );

        console.log(
          `⚡ EST GAS COST:\n  ${gas.toFixed(6)} USDC\n`
        );

        console.log(
          `⚡ FLASH LOAN FEE:\n  ${fee.toFixed(6)} USDC\n`
        );

        console.log(
          `⚡ SLIPPAGE BUFFER:\n  ${slip.toFixed(6)} USDC\n`
        );

        if (net <= 0) {

          console.log(
            `${RED}⚡ RESULT:\nSKIPPED${RESET}`
          );

          console.log(
            "====================================================\n"
          );

          continue;
        }

        console.log(
          `${GREEN}⚡ RESULT:\nPROFITABLE${RESET}`
        );

        console.log(
          "====================================================\n"
        );

        const batch = {

          buyRouters: [
            arb.buyDex.address
          ],

          sellRouters: [
            arb.sellDex.address
          ],

          amountsInUSDC: [
            TRADE_AMOUNT
          ],

          pathsToToken: [
            r.pathBuy
          ],

          pathsToUSDC: [
            r.pathSell
          ],

          deadline:
            Math.floor(
              Date.now() / 1000
            ) + 120
        };

        const ok =
          await simulate(batch);

        if (!ok) {

          console.log(
            `${RED}⚡ SIMULATION FAILED:\nSKIPPED${RESET}\n`
          );

          console.log(
            "====================================================\n"
          );

          continue;
        }

        const profitScaled =
          ethers.parseUnits(
            net.toFixed(6),
            6
          );

        totalNetProfit +=
          profitScaled;

        totalTrades++;

        await execute(
          batch,
          r.symbol,
          net,
          start,
          arb,
          totalNetProfit,
          totalTrades
        );

      } catch (err) {

        console.log(
          `❌ ERROR:\n${r.symbol} → ${err.message}\n`
        );
      }
    }

    console.log(
      "⏳ LOOPING...\n"
    );

    await sleep(
      LOOP_DELAY
    );
  }
}

/* =========================================================
   START
========================================================= */

main().catch((err) => {

  console.error(
    "FATAL:",
    err
  );

  process.exit(1);
});
