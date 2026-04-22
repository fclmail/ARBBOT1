

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
  "https://polygon-mainnet.core.chainstack.com/46058733cb4d6319063e68f8673791a8",
  //"https://polygon-bor-rpc.publicnode.com",
//  "https://polygon.llamarpc.com",
//  "https://polygon.drpc.org",
 // "https://polygon-public.nodies.app"
];

let rpcIndex = 0;
let provider;
let wallet;
let usdc;
let vault;
let routerContracts;

/* ================= CONFIG ================= */

const TRADE_AMOUNT = ethers.parseUnits(".03", 6);
const MIN_PROFIT = ethers.parseUnits("0.000002", 6);
const MIN_BATCH_PROFIT = ethers.parseUnits(".005", 6);

const WORKER_COUNT = 32;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= ABI ================= */

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

const contractAbi = [
  "function executeFlashBatchArbitrage((address[] buyRouters,address[] sellRouters,uint256[] amountsInUSDC,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) batch)",
  "function minimumProfitUSDC() view returns (uint256)"
];

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
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
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
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

function fmt(x) {
  return ethers.formatUnits(x, 6);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ================= STATE ================= */

let microTrades = [];
let runningProfit = 0n;
let isExecuting = false;

/* ================= INIT ================= */

function rebuildContracts() {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  usdc = new ethers.Contract(USDC, erc20Abi, provider);
  vault = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);

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

  return new ethers.JsonRpcProvider(
    url,
    { name: "matic", chainId: 137 },
    { staticNetwork: true }
  );
}

async function initProvider() {
  provider = newProvider();
  await provider.getNetwork();
  rebuildContracts();

  const onchainMin = await vault.minimumProfitUSDC();
  console.log(`ONCHAIN MIN PROFIT ${fmt(onchainMin)}\n`);
}

/* ================= BALANCE ================= */

async function getContractUSDC() {
  return await usdc.balanceOf(CONTRACT_ADDRESS);
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {
  try {
    const out =
      await routerContracts[router].getAmountsOut(amount, path);
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
    const buyOut = await quote(buy, TRADE_AMOUNT, bp);
    if (!buyOut) continue;

    for (const sp of buildSellPaths(token)) {
      const sellOut = await quote(sell, buyOut, sp);
      if (!sellOut) continue;

      const profit = sellOut - TRADE_AMOUNT;

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

/* ================= REVALIDATION ================= */

async function revalidateTrades(trades) {
  console.log("\nFULL BATCH REQUOTE START\n");

  const valid = [];

  for (const t of trades) {
    const buyOut = await quote(t.buy, t.amountIn, t.buyPath);
    if (!buyOut) continue;

    const sellOut = await quote(t.sell, buyOut, t.sellPath);
    if (!sellOut) continue;

    const profit = sellOut - t.amountIn;

    if (profit < MIN_PROFIT) continue;

    t.expectedProfit = profit;
    valid.push(t);
  }

  return valid;
}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

  console.log("\nBATCH THRESHOLD REACHED");
  console.log(`REBUILT TRADES ${trades.length}`);

  const valid = await revalidateTrades(trades);

  console.log(`VALID TRADES ${valid.length}`);
  console.log("SORTED BEST → WORST\n");

  valid.sort((a, b) =>
    b.expectedProfit > a.expectedProfit ? 1 : -1
  );

  const beforeBal = await getContractUSDC();

  let usable = [];
  let usedCapital = 0n;
  let usableProfit = 0n;

  for (const t of valid) {
    if (usedCapital + t.amountIn > beforeBal) break;

    usedCapital += t.amountIn;
    usableProfit += t.expectedProfit;
    usable.push(t);
  }

  if (usable.length === 0) {
    console.log("NO USABLE TRADES\n");
    isExecuting = false;
    return;
  }

  console.log(`EXECUTING TRADES ${usable.length}`);
  console.log(`USED CAPITAL ${fmt(usedCapital)} USDC`);
  console.log(`PROFIT ${fmt(usableProfit)}\n`);

  const fee = await provider.getFeeData();

  const tx =
    await vault.executeFlashBatchArbitrage(
      {
        buyRouters: usable.map(t => t.buy),
        sellRouters: usable.map(t => t.sell),
        amountsInUSDC: usable.map(t => t.amountIn),
        pathsToToken: usable.map(t => t.buyPath),
        pathsToUSDC: usable.map(t => t.sellPath),
        deadline: Math.floor(Date.now() / 1000) + 30
      },
      {
        gasLimit: 2000000,
        maxFeePerGas: fee.maxFeePerGas * 12n / 10n,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 12n / 10n
      }
    );

  console.log(`TX SENT ${tx.hash}\n`);

  await provider.waitForTransaction(tx.hash);

  const afterBal = await getContractUSDC();

  const delta =
    afterBal > beforeBal
      ? afterBal - beforeBal
      : 0n;

  console.log(`CONTRACT BEFORE ${fmt(beforeBal)}`);
  console.log(`CONTRACT AFTER  ${fmt(afterBal)}`);
  console.log(`REAL PROFIT     ${fmt(delta)}\n`);

  isExecuting = false;
}

/* ================= SCANNER ================= */

async function scanLoop() {

  const tasks = [];

  for (const b of Object.values(routers)) {
    for (const s of Object.values(routers)) {
      if (b === s) continue;

      for (const t of Object.values(TOKENS)) {
        tasks.push({ buy: b, sell: s, token: t });
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

      const task = tasks[i++ % tasks.length];

      const trade =
        await findTrade(task.buy, task.sell, task.token);

      if (!trade) continue;

      microTrades.push(trade);
      runningProfit += trade.expectedProfit;

      console.log(`RUNNING TOTAL ${fmt(runningProfit)}`);

      if (!isExecuting && runningProfit >= MIN_BATCH_PROFIT) {

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
  await initProvider();
  await scanLoop();
})();
