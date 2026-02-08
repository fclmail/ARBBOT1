import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const RPC_POLYGON =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL ||
  "";

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  process.env.WALLET_PRIVATE_KEY ||
  "";

if (!RPC_POLYGON || !PRIVATE_KEY) {
  console.error("❌ Missing RPC_POLYGON or PRIVATE_KEY");
  process.exit(1);
}

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";
const RESET = "\x1b[0m";

/* ================= PARAMS ================= */

const MIN_TRADE_USDC = 1.0;
const MIN_EXPECTED_PROFIT = 0.000001; // adjustable
const SCAN_INTERVAL_MS = 5_000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function usdc() view returns(address)"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:    "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])"
];

/* ================= TOKENS (RESTORED ALL) ================= */

const TOKENS = {
  USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC:  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE:   "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV:   "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI:   "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH:  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK:  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE:  "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function quote(router, amountIn, path) {
  try {
    const r = new ethers.Contract(router, routerAbi, provider);
    const out = await r.getAmountsOut(amountIn, path);
    return out[out.length - 1];
  } catch {
    return null;
  }
}

/* ================= PATHS ================= */

function buyPaths(usdc, token) {
  return [
    [usdc, token],
    [usdc, TOKENS.WMATIC, token],
    [usdc, TOKENS.WETH, token],
    [usdc, TOKENS.USDT, token],
    [usdc, TOKENS.DAI, token]
  ];
}

function sellPaths(usdc, token) {
  return [
    [token, usdc],
    [token, TOKENS.WMATIC, usdc],
    [token, TOKENS.WETH, usdc],
    [token, TOKENS.USDT, usdc],
    [token, TOKENS.DAI, usdc]
  ];
}

/* ================= BALANCES ================= */

async function logBalances(usdcAddr) {
  const matic = await provider.getBalance(wallet.address);
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );
  const vaultBal = await usdc.balanceOf(VAULT_ADDRESS);

  console.log(
    `${CYAN}👛 Wallet:${RESET} ${wallet.address}\n` +
    `${YELLOW}⛽ MATIC:${RESET} ${ethers.formatEther(matic)}\n` +
    `${GREEN}🏦 Vault USDC:${RESET} ${ethers.formatUnits(vaultBal, 6)}`
  );
}

/* ================= ARBITRAGE ================= */

async function tryArb(buyRouter, sellRouter, token) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuy, bestBuyPath;
  // Parallelize buy path quotes for a given buyRouter
  const buyPromises = buyPaths(usdc, token).map(p => quote(buyRouter, amountIn, p));
  const buyOuts = await Promise.all(buyPromises);
  buyOuts.forEach((out, idx) => {
    const path = buyPaths(usdc, token)[idx];
    if (out && (!bestBuy || out > bestBuy)) {
      bestBuy = out;
      bestBuyPath = path;
    }
  });
  if (!bestBuy) return;

  let bestSell, bestSellPath;
  const sellPathsList = sellPaths(usdc, token);
  const sellPromises = sellPathsList.map(p => quote(sellRouter, bestBuy, p));
  const sellOuts = await Promise.all(sellPromises);
  sellOuts.forEach((out, idx) => {
    const path = sellPathsList[idx];
    if (out && (!bestSell || out > bestSell)) {
      bestSell = out;
      bestSellPath = path;
    }
  });
  if (!bestSell) return;

  const profit = Number(ethers.formatUnits(bestSell, 6)) - MIN_TRADE_USDC;
  const profitPct = (profit / MIN_TRADE_USDC) * 100;

  // Debug / visibility: show current buy/sell prices and potential profit
  console.log(
    `${CYAN}🔎 ARB CHECK${RESET} token=${token} buyRouter=${buyRouter.substring(0,6)}... sellRouter=${sellRouter.substring(0,6)}...`
  );
  console.log(
    `  ${YELLOW}Buy path:${RESET} ${bestBuyPath.map(addr => addr.toLowerCase()).join(" -> ")}`
  );
  console.log(
    `  ${YELLOW}Best buy (USDC -> token) price:${RESET} ${ethers.FormatUnits
      ? "" // placeholder to keep syntax consistent in environments without this path
      : ""}`
  );
  // Print actual numeric price for bestBuy in human-readable form
  console.log(
    `  ${YELLOW}Best buy amountOut:${RESET} ${bestBuy ? ethers.formatUnits(bestBuy, 18) : "N/A"}`
  );
  console.log(
    `  ${YELLOW}Sell path:${RESET} ${bestSellPath.map(addr => addr.toLowerCase()).join(" -> ")}`
  );
  console.log(
    `  ${YELLOW}Best sell amountOut (USDC):${RESET} ${bestSell ? ethers.formatUnits(bestSell, 6) : "N/A"}`
  );
  console.log(
    `  ${YELLOW}Estimated profit:${RESET} ${profit.toFixed(6)} USDC (${profitPct.toFixed(6)}%)`
  );

  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log(`${GREEN}🔥 PROFIT FOUND:${RESET} ${profit.toFixed(6)} USDCe`);
  console.log(`${YELLOW}🧪 SIMULATION START${RESET}`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const args = [
    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath,
    deadline
  ];

  await vault.callStatic.executeArbitrage(...args);
  console.log(`${GREEN}🧪 SIMULATION PASSED${RESET}`);

  const tx = await vault.executeArbitrage(...args);
  console.log(`${CYAN}⚡ TX SENT:${RESET} ${tx.hash}`);
  await tx.wait();

  console.log(`${GREEN}✅ PROFITS DEPOSITED INTO VAULT${RESET}`);
}

/* ================= SCAN ================= */

async function scan() {
  console.log(`\n🔍 Scan @ ${new Date().toISOString()}`);
  const usdc = await vault.usdc();
  await logBalances(usdc);

  // To keep behavior identical to the original, we iterate all combos but
  // we also show per-combination price data via tryArb logs.
  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy !== sell) {
          await tryArb(buy, sell, token);
          await sleep(100);
        }
      }
    }
  }
}

/* ================= START ================= */

console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(e =>
    console.error(`${RED}❌ ERROR:${RESET}`, e.message)
  );
}, SCAN_INTERVAL_MS);
