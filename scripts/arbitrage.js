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

const TRADE_AMOUNT_USDC = 0.02;   // adjustable
const MIN_PROFIT_USDC = 0.000001; // adjustable
const MAX_BATCH_SIZE = 100;
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

const usdc = new ethers.Contract(
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  ["function balanceOf(address) view returns(uint256)"],
  provider
);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

const routerContracts = Object.fromEntries(
  Object.values(routers).map(
    (a) => [a, new ethers.Contract(a, routerAbi, provider)]
  )
);

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

/* ================= HELPERS ================= */

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, ms));

async function logBalances() {

  const vaultUSDC = await usdc.balanceOf(
    VAULT_ADDRESS
  );

  const matic = await provider.getBalance(
    wallet.address
  );

  console.log(
    `${CYAN}Vault USDC:${RESET}`,
    ethers.formatUnits(vaultUSDC, 6)
  );

  console.log(
    `${CYAN}Wallet MATIC:${RESET}`,
    ethers.formatEther(matic)
  );
}

/* ================= QUOTE ================= */

async function quote(router, amount, path) {

  try {

    const r = routerContracts[router];

    const a = await r.getAmountsOut(
      amount,
      path
    );

    return a.at(-1);

  } catch {

    return null;

  }
}

/* ================= FIND ================= */

async function findTrade(buy, sell, token) {

  const amountIn = ethers.parseUnits(
    TRADE_AMOUNT_USDC.toString(),
    6
  );

  const usdc = TOKENS.USDC;

  const buyPaths = [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token],
    [usdc, TOKENS.USDT, token],
    [usdc, TOKENS.DAI, token]
  ];

  const sellPaths = [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc],
    [token, TOKENS.USDT, usdc],
    [token, TOKENS.DAI, usdc]
  ];

  let bestBuyOut;
  let bestBuyPath;

  for (const p of buyPaths) {

    const out = await quote(
      buy,
      amountIn,
      p
    );

    if (out && (!bestBuyOut || out > bestBuyOut)) {

      bestBuyOut = out;
      bestBuyPath = p;

    }
  }

  if (!bestBuyOut) return null;

  let bestSellOut;
  let bestSellPath;

  for (const p of sellPaths) {

    const out = await quote(
      sell,
      bestBuyOut,
      p
    );

    if (out && (!bestSellOut || out > bestSellOut)) {

      bestSellOut = out;
      bestSellPath = p;

    }
  }

  if (!bestSellOut) return null;

  const profit =
    Number(
      ethers.formatUnits(
        bestSellOut,
        6
      )
    ) - TRADE_AMOUNT_USDC;

  if (profit < MIN_PROFIT_USDC)
    return null;

  console.log(
    `${GREEN}PROFIT${RESET}`,
    profit.toFixed(6)
  );

  return {
    buy,
    sell,
    amountIn,
    bestBuyPath,
    bestSellPath,
    profit
  };
}

/* ================= BATCH ================= */

async function batchArb() {

  await logBalances();

  const trades = [];

  while (
    trades.length < MAX_BATCH_SIZE
  ) {

    const tasks = [];

    for (const buy of Object.values(
      routers
    )) {
      for (const sell of Object.values(
        routers
      )) {

        if (buy === sell) continue;

        for (const t of Object.values(
          TOKENS
        )) {

          tasks.push(
            findTrade(
              buy,
              sell,
              t
            )
          );

        }
      }
    }

    const res =
      await Promise.all(tasks);

    for (const r of res) {

      if (r) {

        trades.push(r);

        if (
          trades.length >=
          MAX_BATCH_SIZE
        )
          break;
      }
    }

    const totalProfit =
      trades.reduce(
        (s, t) =>
          s + t.profit,
        0
      );

    console.log(
      `${YELLOW}Collected${RESET}`,
      trades.length,
      "Total:",
      totalProfit.toFixed(6)
    );
  }

  console.log(
    `${CYAN}FULL BATCH READY${RESET}`
  );

  const deadline =
    Math.floor(
      Date.now() / 1000
    ) + DEADLINE_SECONDS;

  const batch = {
    buyRouters:
      trades.map(
        (t) => t.buy
      ),

    sellRouters:
      trades.map(
        (t) => t.sell
      ),

    amountsInUSDC:
      trades.map(
        (t) => t.amountIn
      ),

    pathsToToken:
      trades.map(
        (t) =>
          t.bestBuyPath
      ),

    pathsToUSDC:
      trades.map(
        (t) =>
          t.bestSellPath
      ),

    deadline
  };

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
            (gas *
              130n) /
            100n
        }
      );

    console.log(
      `${GREEN}TX${RESET}`,
      tx.hash
    );

    await tx.wait();

    console.log(
      `${GREEN}CONFIRMED${RESET}`
    );

  } catch (e) {

    console.log(
      `${RED}FAIL${RESET}`,
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
