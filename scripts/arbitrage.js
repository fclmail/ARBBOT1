import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= RPC ================= */

const RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
 // "https://polygon.llamarpc.com",
 // "https://polygon.drpc.org",
 // "https://polygon-public.nodies.app"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits("0.03", 6);
const MIN_PROFIT = ethers.parseUnits("0.000003", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits("0.0002", 6);

const WORKER_COUNT = 32;

/* ================= GAS TOP-UP ================= */

const WITHDRAW_THRESHOLD = ethers.parseUnits(".05", 6);
const WITHDRAW_PERCENT = 10n;

const MIN_POL_FOR_TX = ethers.parseEther("0.35");

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256)"
];

const contractAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
  "function minimumProfitUSDC() view returns (uint256)",
  "function withdrawERC20(address,uint256)"
];

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */

const TOKENS = {
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
    CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
  SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS ================= */

const fmt = x => ethers.formatUnits(x, 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let isExecuting = false;

/* ================= INIT ================= */

function rebuildContracts() {

  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  usdc = new ethers.Contract(
    USDC,
    erc20Abi,
    wallet
  );

  vault = new ethers.Contract(
    CONTRACT_ADDRESS,
    contractAbi,
    wallet
  );

  routerContracts = Object.fromEntries(
    Object.values(routers).map(a => [
      a,
      new ethers.Contract(a, routerAbi, provider)
    ])
  );
}

function newProvider() {

  const url = RPCS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPCS.length;

  return new ethers.JsonRpcProvider(url);
}

async function initProvider() {

  provider = newProvider();

  await provider.getNetwork();

  rebuildContracts();

  const onchainMin = await vault.minimumProfitUSDC();

  console.log(`ONCHAIN MIN PROFIT ${fmt(onchainMin)}\n`);
}

/* ================= GAS TOPUP ================= */

async function topUpGas() {

  try {

    const contractBal =
      await usdc.balanceOf(CONTRACT_ADDRESS);

    if (contractBal < WITHDRAW_THRESHOLD) {
      console.log("⚠️ CONTRACT USDC TOO LOW FOR GAS TOPUP\n");
      return;
    }

    const amount =
      (contractBal * WITHDRAW_PERCENT) / 100n;

    console.log(`⚡ GAS TOP-UP ${fmt(amount)} USDC`);

    await (
      await vault.withdrawERC20(USDC, amount)
    ).wait();

    await (
      await usdc.approve(routers.QuickSwap, amount)
    ).wait();

    const router = new ethers.Contract(
      routers.QuickSwap,
      routerAbi,
      wallet
    );

    await (
      await router.swapExactTokensForTokens(
        amount,
        0,
        [USDC, TOKENS.WMATIC],
        wallet.address,
        Math.floor(Date.now() / 1000) + 120
      )
    ).wait();

    console.log("✅ USDC → WMATIC");

    const wmatic = new ethers.Contract(
      TOKENS.WMATIC,
      [
        "function withdraw(uint256)",
        "function balanceOf(address) view returns(uint256)"
      ],
      wallet
    );

    const bal =
      await wmatic.balanceOf(wallet.address);

    if (bal > 0n) {

      await (await wmatic.withdraw(bal)).wait();

      console.log("🔥 WMATIC → POL");
    }

  } catch (e) {

    console.log(`⚠️ GAS TOP-UP FAILED: ${e.message}`);
  }
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {

  try {

    const out =
      await routerContracts[router].getAmountsOut(
        amount,
        path
      );

    return out.at(-1);

  } catch {

    return null;
  }
}

/* ================= PATHS ================= */

function buildBuyPaths(token) {

  return [
    [USDC, token],
    [USDC, TOKENS.WETH, token],
    [USDC, TOKENS.WMATIC, token],
    [USDC, TOKENS.DAI, token],
    [USDC, TOKENS.USDT, token]
  ];
}

function buildSellPaths(token) {

  return [
    [token, USDC],
    [token, TOKENS.WETH, USDC],
    [token, TOKENS.WMATIC, USDC],
    [token, TOKENS.DAI, USDC],
    [token, TOKENS.USDT, USDC]
  ];
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, token) {

  for (const bp of buildBuyPaths(token)) {

    const buyOut =
      await quote(buy, TRADE_AMOUNT, bp);

    if (!buyOut) continue;

    for (const sp of buildSellPaths(token)) {

      const sellOut =
        await quote(sell, buyOut, sp);

      if (!sellOut) continue;

      const profit =
        sellOut - TRADE_AMOUNT;

      if (profit < MIN_PROFIT) continue;

      return {
        buy,
        sell,
        token,
        amountIn: TRADE_AMOUNT,
        buyPath: bp,
        sellPath: sp,
        expectedProfit: profit
      };
    }
  }

  return null;
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

  console.log("\nBATCH THRESHOLD REACHED");

  const polBal =
    await provider.getBalance(wallet.address);

  console.log(
    `POL BALANCE ${ethers.formatEther(polBal)}`
  );

  if (polBal < MIN_POL_FOR_TX) {

    console.log(
      `⚠️ LOW POL BALANCE ${ethers.formatEther(polBal)}`
    );

    await topUpGas();

    const newBal =
      await provider.getBalance(wallet.address);

    console.log(
      `POL AFTER TOPUP ${ethers.formatEther(newBal)}\n`
    );
  }

  const beforeBal =
    await usdc.balanceOf(CONTRACT_ADDRESS);

  let tx;

  try {

    tx =
      await vault.executeFlashBatchArbitrage({
        buyRouters: trades.map(t => t.buy),
        sellRouters: trades.map(t => t.sell),
        amountsInUSDC: trades.map(t => t.amountIn),
        pathsToToken: trades.map(t => t.buyPath),
        pathsToUSDC: trades.map(t => t.sellPath),
        deadline: Math.floor(Date.now() / 1000) + 30
      });

  } catch (e) {

    console.log(
      `⚠️ EXECUTION FAILED: ${e.message}\n`
    );

    isExecuting = false;
    return;
  }

  console.log(`TX SENT ${tx.hash}`);

  await provider.waitForTransaction(tx.hash);

  const afterBal =
    await usdc.balanceOf(CONTRACT_ADDRESS);

  const profit =
    afterBal - beforeBal;

  console.log(`CONTRACT BEFORE ${fmt(beforeBal)}`);
  console.log(`CONTRACT AFTER  ${fmt(afterBal)}`);
  console.log(`REAL PROFIT     ${fmt(profit)}\n`);

  isExecuting = false;
}

/* ================= SCAN LOOP ================= */

async function scanLoop() {

  const tasks = [];

  for (const b of Object.values(routers)) {

    for (const s of Object.values(routers)) {

      if (b === s) continue;

      for (const t of Object.values(TOKENS)) {

        tasks.push({
          buy: b,
          sell: s,
          token: t
        });
      }
    }
  }

  let i = 0;

  async function worker() {

    while (true) {

      if (isExecuting) {

        await sleep(5);
        continue;
      }

      const task =
        tasks[i++ % tasks.length];

      const trade =
        await findTrade(
          task.buy,
          task.sell,
          task.token
        );

      if (!trade) continue;

      microTrades.push(trade);

      runningProfit += trade.expectedProfit;

      console.log(
        `RUNNING TOTAL ${fmt(runningProfit)}`
      );

      if (
        !isExecuting &&
        runningProfit >= MIN_BATCH_PROFIT
      ) {

        isExecuting = true;

        const batch = [...microTrades];

        microTrades = [];
        runningProfit = 0n;

        await executeBatch(batch);
      }
    }
  }

  await Promise.all(
    Array.from({ length: WORKER_COUNT }, worker)
  );
}

/* ================= MAIN ================= */

(async function main() {

  console.log("🚀 BOT STARTED\n");

  await initProvider();

  const bal =
    await provider.getBalance(wallet.address);

  console.log(
    `STARTING POL BALANCE ${ethers.formatEther(bal)}\n`
  );

  await scanLoop();

})();
