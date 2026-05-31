import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL;

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

if (!RPC_POLYGON) throw new Error("RPC missing");
if (!PRIVATE_KEY) throw new Error("PK missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

/* ================= CONFIG ================= */

const TRADE_AMOUNT_USDC = 0.01;
const MIN_PROFIT_USDC = 0.0001;
const MIN_BATCH_PROFIT_USDC = 0.01;
const MAX_BATCH_SIZE = 200;
const BUFFER_TIMEOUT_MS = 10000;
const SCAN_INTERVAL_MS = 500;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0xC1888f15C47e79E45342Dea9249622476A83563f";

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
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
  },
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= USDC ================= */

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const usdc = new ethers.Contract(
  USDC,
  ["function balanceOf(address) view returns(uint256)"],
  provider
);

/* ================= DEXES ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef",
};

const routerAbi = [
  "function getAmountsOut(uint,address[]) view returns(uint[])"
];

/* ================= TOKENS ================= */

const TOKENS = {
 AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
AXLUSDC: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159",
BETA: "0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde",
BONE: "0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e",
CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
DPI: "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b",
FND: "0x292c4eefdda27062049d44d4730d5fe774b5f4c7",
FREE: "0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238",
KLIMA: "0x4e78011ce80ee02d2c3e649fb657e45898257815",
LDO: "0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4",
LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
MATICX: "0xa3fa99a148fa48d14ed51d610c367c61876997f1",
OS: "0xd3a691c852cdb01e281545a27064741f0b7f6825",
QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
RNDR: "0x6c3c7886b43d005db8c28a09e8038b87e36cf26c",
SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
SHIKIGON: "0x3f0fb6e42d160a8def49fe68b8ef4d8a5b7ab119",
SURE: "0xf638a9594c0c780d6c8bc40fa33efb0ceabf5d57",
THE7: "0x045f7ffdcc8334e78316a2c1164efb2e5f3815d5",
TRADE: "0x82362ec182db3cf7829014bc61e9be8a2e82868a",
UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
UNI2: "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
XSGD: "0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0"
};

/* ================= BUFFER ================= */

let tradeBuffer = [];
let bufferedProfit = 0;
let lastFlush = Date.now();

/* ================= STATUS LOGGER ================= */

setInterval(() => {
  console.log(CYAN, "\nBUFFER STATUS (10s)", RESET);
  console.log(CYAN, ` Buffered trades: ${tradeBuffer.length}`, RESET);
  console.log(
    CYAN,
    ` Buffered profit: ${bufferedProfit.toFixed(6)}`,
    RESET
  );
  console.log(
    CYAN,
    ` Time since last send: ${(
      (Date.now() - lastFlush) / 1000
    ).toFixed(1)}s`,
    RESET
  );
}, 10000);

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logBalances() {
  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);
  const maticBal = await provider.getBalance(wallet.address);

  console.log(`Vault USDC: ${ethers.formatUnits(vaultBal, 6)}`);
  console.log(`Wallet MATIC: ${ethers.formatEther(maticBal)}`);
}

async function quote(router, amount, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const out = await r.getAmountsOut(amount, path);
    return out.at(-1);
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
    [USDC, TOKENS.USDT, token],
  ];
}

function buildSell(token) {
  return [
    [token, USDC],
    [token, TOKENS.WETH, USDC],
    [token, TOKENS.WMATIC, USDC],
    [token, TOKENS.DAI, USDC],
    [token, TOKENS.USDT, USDC],
  ];
}

/* ================= FIND TRADE ================= */

async function findTrade(buy, sell, token) {
  const amountIn = ethers.parseUnits(
    TRADE_AMOUNT_USDC.toString(),
    6
  );

  for (const bp of buildPaths(token)) {
    const buyOut = await quote(buy, amountIn, bp);
    if (!buyOut) continue;

    for (const sp of buildSell(token)) {
      const sellOut = await quote(sell, buyOut, sp);
      if (!sellOut) continue;

      const profit =
        Number(ethers.formatUnits(sellOut, 6)) -
        TRADE_AMOUNT_USDC;

      if (profit < MIN_PROFIT_USDC) continue;

      return {
        buy,
        sell,
        amountIn,
        buyPath: bp,
        sellPath: sp,
        expectedProfit: profit,
      };
    }
  }

  return null;
}

/* ================= MICRO AGG ================= */

function aggregateTrades(trades) {
  const map = new Map();

  for (const t of trades) {
    const key =
      t.buy +
      t.sell +
      t.buyPath.join(",") +
      t.sellPath.join(",");

    if (!map.has(key)) {
      map.set(key, {
        ...t,
        totalAmount: 0n,
        totalExpectedProfit: 0,
      });
    }

    const g = map.get(key);

    g.totalAmount += t.amountIn;
    g.totalExpectedProfit += t.expectedProfit;
  }

  return [...map.values()];
}

/* ================= SEND ================= */

async function flushBuffer() {
  if (tradeBuffer.length === 0) return;

  const grouped = aggregateTrades(tradeBuffer);

  const expectedProfit = grouped.reduce(
    (s, x) => s + x.totalExpectedProfit,
    0
  );

  console.log(
    YELLOW,
    `\nMICRO AGGREGATED: ${grouped.length}`,
    RESET
  );

  console.log(
    GREEN,
    `Expected batch profit: ${expectedProfit.toFixed(6)}`,
    RESET
  );

  if (expectedProfit < MIN_BATCH_PROFIT_USDC) {
    console.log(RED, "BATCH BLOCKED", RESET);
    return;
  }

  console.log(GREEN, "BATCH APPROVED", RESET);

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const batch = {
    buyRouters: grouped.map((x) => x.buy),
    sellRouters: grouped.map((x) => x.sell),
    amountsInUSDC: grouped.map((x) => x.totalAmount),
    pathsToToken: grouped.map((x) => x.buyPath),
    pathsToUSDC: grouped.map((x) => x.sellPath),
    deadline,
  };

  console.log("\nSimulating...");

  const ok = await vault.executeFlashBatchArbitrage
    .staticCall(batch)
    .then(() => true)
    .catch(() => false);

  if (!ok) {
    console.log(RED, "SIM FAIL", RESET);
    return;
  }

  console.log(GREEN, "SIM PASS", RESET);

  const tx = await vault.executeFlashBatchArbitrage(batch);

  console.log(`\nTX ${tx.hash}`);

  await tx.wait();

  console.log("\nCONFIRMED");

  await logBalances();

  tradeBuffer = [];
  bufferedProfit = 0;
  lastFlush = Date.now();
}

/* ================= LOOP ================= */

async function scanLoop() {
  while (true) {
    console.log("\nSCANNING...\n");

    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;

        for (const token of Object.values(TOKENS)) {
          const t = await findTrade(buy, sell, token);

          if (!t) continue;

          console.log(
            GREEN,
            `PROFIT FOUND +${t.expectedProfit.toFixed(6)}`,
            RESET
          );

          tradeBuffer.push(t);
          bufferedProfit += t.expectedProfit;
        }
      }
    }

    if (
      tradeBuffer.length > 0 &&
      (
        bufferedProfit >= MIN_BATCH_PROFIT_USDC ||
        tradeBuffer.length >= MAX_BATCH_SIZE ||
        Date.now() - lastFlush > BUFFER_TIMEOUT_MS
      )
    ) {
      await flushBuffer();
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

/* ================= MAIN ================= */

(async function main() {
  await logBalances();
  await scanLoop();
})();
