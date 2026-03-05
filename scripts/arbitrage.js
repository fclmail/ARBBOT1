import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= CONFIG ================= */
const RPC_LIST = (
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  ""
)
  .split(",")
  .map(rpc => rpc.trim())
  .filter(Boolean);

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

if (!RPC_LIST.length) throw new Error("No RPC endpoints provided");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");

const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.4);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.0005);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 2000);
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
const DRY_RUN = (process.env.DRY_RUN || "false") === "true";

/* ================= TIMESTAMP ================= */
const ts = () => new Date().toISOString();

/* ================= PROVIDER ================= */
async function getWorkingProvider() {
  for (const rpc of RPC_LIST) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      console.log(`[${ts()}] ✅ Connected RPC: ${rpc}`);
      return provider;
    } catch {
      console.log(`[${ts()}] ⚠️ RPC failed: ${rpc}`);
    }
  }
  throw new Error("All RPC endpoints failed");
}

const provider = await getWorkingProvider();
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  {
    name: "executeArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ]
  },
  {
    name: "usdc",
    type: "function",
    stateMutability: "view",
    outputs: [{ type: "address" }]
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AaCbBfB5A45",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  LINK: "0x53E0bca35eC356BD5ddDFEBBD1Fc0fD03FaBad39",
  AAVE: "0xD6Df932A45C0f255f85145f286eA0B292B21C90B"
};

/* ================= SYMBOL MAP ================= */
const TOKEN_SYMBOLS = Object.fromEntries(
  Object.entries(TOKENS).map(([sym, addr]) => [addr.toLowerCase(), sym])
);

function symbol(addr) {
  return TOKEN_SYMBOLS[addr.toLowerCase()] || addr.slice(0, 6);
}

/* ================= HELPERS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function quote(router, amountIn, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const amounts = await r.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= HOP PATHS ================= */
function buildPaths(usdc, token) {

  const hops = [
    TOKENS.WETH,
    TOKENS.WMATIC,
    TOKENS.DAI,
    TOKENS.USDT
  ];

  const paths = [];

  // direct
  paths.push({
    buy: [usdc, token],
    sell: [token, usdc]
  });

  for (const hop of hops) {

    if (hop === token) continue;

    paths.push({
      buy: [usdc, hop, token],
      sell: [token, hop, usdc]
    });

    paths.push({
      buy: [usdc, hop, token],
      sell: [token, usdc]
    });

    paths.push({
      buy: [usdc, token],
      sell: [token, hop, usdc]
    });
  }

  return paths;
}

/* ================= ARB CHECK ================= */
async function checkArb(buyRouter, sellRouter, tokenAddr, usdc) {

  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  const paths = buildPaths(usdc, tokenAddr);

  for (const p of paths) {

    const buyOut = await quote(buyRouter, amountIn, p.buy);
    if (!buyOut) continue;

    const sellOut = await quote(sellRouter, buyOut, p.sell);
    if (!sellOut) continue;

    const received = Number(ethers.formatUnits(sellOut, 6));
    const profit = received - MIN_TRADE_USDC;

    if (profit >= MIN_EXPECTED_PROFIT) {

      return {
        buyRouter,
        sellRouter,
        tokenAddr,
        buyPath: p.buy,
        sellPath: p.sell,
        profit
      };

    }
  }

  return null;
}

/* ================= EXECUTION ================= */
async function executeArb(arb) {

  console.log(`[${ts()}] 🔥 EXECUTING ${symbol(arb.tokenAddr)} +${arb.profit.toFixed(6)} USDC`);

  if (DRY_RUN) {
    console.log(`[${ts()}] DRY RUN`);
    return;
  }

  try {

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
    const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

    const tx = await vault.executeArbitrage(
      arb.buyRouter,
      arb.sellRouter,
      amountIn,
      arb.buyPath,
      arb.sellPath,
      deadline
    );

    console.log(`[${ts()}] TX SENT ${tx.hash}`);

    await tx.wait();

    console.log(`[${ts()}] ✅ CONFIRMED`);

  } catch (e) {

    console.log(`[${ts()}] ⚠️ TX FAILED ${e.message}`);

  }
}

/* ================= SCAN ================= */
async function scan() {

  const usdc = await vault.usdc();

  const found = [];

  const tasks = [];

  for (const [sym, tokenAddr] of Object.entries(TOKENS)) {

    if (sym === "USDC") continue;

    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {

        if (buyRouter === sellRouter) continue;

        tasks.push(async () => {

          const arb = await checkArb(buyRouter, sellRouter, tokenAddr, usdc);

          if (arb) found.push(arb);

        });

      }
    }
  }

  for (let i = 0; i < tasks.length; i += SCAN_CONCURRENCY) {

    await Promise.all(tasks.slice(i, i + SCAN_CONCURRENCY).map(t => t()));

  }

  if (!found.length) return;

  found.sort((a, b) => b.profit - a.profit);

  console.log(`[${ts()}] 💡 ${found.length} opportunities`);

  for (const arb of found) {

    await executeArb(arb);

  }
}

/* ================= LOOP ================= */
(async () => {

  console.log(`[${ts()}] 🚀 ARB BOT STARTED`);

  while (true) {

    try {

      await scan();

    } catch (e) {

      console.log(`[${ts()}] ERROR ${e.message}`);

    }

    await sleep(SCAN_DELAY_MS);

  }

})();
