import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PK missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONFIG ================= */

const TRADE_AMOUNT_USDC = 0.01;
const MIN_PROFIT_USDC = 0.00001;
const MAX_BATCH_SIZE = 10;
const DEADLINE_SECONDS = 60;
const SCAN_INTERVAL_MS = 500;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS =
  "0xC1888f15C47e79E45342Dea9249622476A83563f";

const vaultAbi = [
  {
    name: "executeFlashBatchArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "batch",
        type: "tuple",
        components: [
          { name: "buyRouters", type: "address[]" },
          { name: "sellRouters", type: "address[]" },
          { name: "amountsInUSDC", type: "uint256[]" },
          { name: "pathsToToken", type: "address[][]" },
          { name: "pathsToUSDC", type: "address[][]" },
          { name: "deadline", type: "uint256" }
        ]
      }
    ]
  }
];

const vault = new ethers.Contract(
  VAULT_ADDRESS,
  vaultAbi,
  wallet
);

/* ================= USDC ================= */

const USDC =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const usdc = new ethers.Contract(
  USDC,
  ["function balanceOf(address) view returns(uint256)"],
  wallet
);

/* ================= ROUTERS ================= */

const routers = {

  QuickSwap:
    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",

  SushiSwap:
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",

  Dfyn:
    "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",

  Firebird:
    "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",

  ApeSwap:
    "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",

  Wault:
    "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"

};

const routerAbi =
  ["function getAmountsOut(uint,address[]) view returns(uint[])"];

/* ================= TOKENS ================= */

const TOKENS = {

  WMATIC:
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",

  WETH:
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",

  DAI:
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",

  USDT:
    "0xc2132D05D31c914a87C6611C10748AaCbB7c7c06",

  WBTC:
    "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"

};

/* ================= HELPERS ================= */

const sleep = ms =>
  new Promise(r => setTimeout(r, ms));

async function logBalances() {

  const v =
    await usdc.balanceOf(
      VAULT_ADDRESS
    );

  const m =
    await provider.getBalance(
      wallet.address
    );

  console.log(
    CYAN,
    "Vault USDC:",
    RESET,
    ethers.formatUnits(v, 6)
  );

  console.log(
    CYAN,
    "Wallet MATIC:",
    RESET,
    ethers.formatEther(m)
  );
}

async function quote(
  router,
  amount,
  path
) {
  try {
    const r =
      new ethers.Contract(
        router,
        routerAbi,
        provider
      );

    const a =
      await r.getAmountsOut(
        amount,
        path
      );

    return a.at(-1);

  } catch {
    return null;
  }
}

/* ================= PATHS ================= */

function buildPaths(token) {

  return [

    [USDC, token],

    [USDC, TOKENS.WETH, token],

    [USDC, TOKENS.WMATIC, token],

    [USDC, TOKENS.DAI, token],

    [USDC, TOKENS.USDT, token]

  ];
}

function buildSell(token) {

  return [

    [token, USDC],

    [token, TOKENS.WETH, USDC],

    [token, TOKENS.WMATIC, USDC],

    [token, TOKENS.DAI, USDC],

    [token, TOKENS.USDT, USDC]

  ];
}

/* ================= FIND TRADE ================= */

async function findTrade(
  buy,
  sell,
  token
) {

  const amountIn =
    ethers.parseUnits(
      TRADE_AMOUNT_USDC.toString(),
      6
    );

  const buyPaths =
    buildPaths(token);

  const sellPaths =
    buildSell(token);

  for (const bp of buyPaths) {

    const buyOut =
      await quote(
        buy,
        amountIn,
        bp
      );

    if (!buyOut) continue;

    for (const sp of sellPaths) {

      const sellOut =
        await quote(
          sell,
          buyOut,
          sp
        );

      if (!sellOut) continue;

      const profit =
        Number(
          ethers.formatUnits(
            sellOut,
            6
          )
        ) -
        Number(
          ethers.formatUnits(
            amountIn,
            6
          )
        );

      if (
        profit <
        MIN_PROFIT_USDC
      ) continue;

      console.log(
        GREEN,
        "PROFIT",
        RESET,
        profit.toFixed(6)
      );

      return {
        buy,
        sell,
        amountIn,
        buyPath: bp,
        sellPath: sp,
        profit
      };
    }
  }

  return null;
}

/* ================= MICRO AGG ================= */

function microAggregate(trades) {

  const map =
    new Map();

  for (const t of trades) {

    const key =
      t.buy +
      t.sell +
      t.buyPath.join();

    if (!map.has(key))
      map.set(key, []);

    map.get(key).push(t);
  }

  const out = [];

  for (const g of map.values()) {

    const t = g[0];

    const total =
      g.reduce(
        (s, x) =>
          s +
          Number(
            ethers.formatUnits(
              x.amountIn,
              6
            )
          ),
        0
      );

    const profit =
      g.reduce(
        (s, x) =>
          s + x.profit,
        0
      );

    out.push({

      buy: t.buy,
      sell: t.sell,

      amountIn:
        ethers.parseUnits(
          total.toString(),
          6
        ),

      buyPath: t.buyPath,
      sellPath: t.sellPath,
      profit

    });
  }

  return out;
}

/* ================= SIM ================= */

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

/* ================= BATCH ================= */

async function batchArb() {

  await logBalances();

  const trades = [];

  let totalProfit = 0;

  while (
    trades.length <
    MAX_BATCH_SIZE
  ) {

    const tasks = [];

    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {

        if (buy === sell) continue;

        for (const token of Object.values(TOKENS)) {

          tasks.push(
            findTrade(
              buy,
              sell,
              token
            )
          );

        }
      }
    }

    const res =
      await Promise.all(tasks);

    for (const t of res) {
      if (!t) continue;
      trades.push(t);
      totalProfit += t.profit;
    }

    console.log(
      YELLOW,
      "Collected",
      trades.length,
      "Total:",
      totalProfit.toFixed(6),
      RESET
    );
  }

  let grouped =
    microAggregate(trades);

  console.log(
    "After agg:",
    grouped.length
  );

  const deadline =
    Math.floor(
      Date.now() / 1000
    ) +
    DEADLINE_SECONDS;

  const batch = {

    buyRouters:
      grouped.map(t => t.buy),

    sellRouters:
      grouped.map(t => t.sell),

    amountsInUSDC:
      grouped.map(t => t.amountIn),

    pathsToToken:
      grouped.map(t => t.buyPath),

    pathsToUSDC:
      grouped.map(t => t.sellPath),

    deadline

  };

  console.log(
    "Simulating..."
  );

  const ok =
    await simulate(batch);

  if (!ok) {

    console.log(
      RED,
      "SIM FAIL",
      RESET
    );

    return;
  }

  try {

    const gas =
      await vault.executeFlashBatchArbitrage.estimateGas(
        batch
      );

    const tx =
      await vault.executeFlashBatchArbitrage(
        batch,
        {
          gasLimit:
            (gas * 130n) /
            100n
        }
      );

    console.log(
      GREEN,
      "TX",
      RESET,
      tx.hash
    );

    await tx.wait();

    console.log(
      GREEN,
      "CONFIRMED",
      RESET
    );

  } catch (e) {

    console.log(
      RED,
      "FAIL",
      RESET,
      e.message
    );

  }
}

/* ================= LOOP ================= */

async function main() {

  while (true) {

    await batchArb();

    await sleep(
      SCAN_INTERVAL_MS
    );

  }
}

main();
