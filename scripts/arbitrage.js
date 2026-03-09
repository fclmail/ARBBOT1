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

const MIN_TRADE_USDC = 0.02;

/* accounts for router fees + slippage */
const PROFIT_BUFFER = 0.001;

/* minimum real profit required */
const MIN_EXPECTED_PROFIT = 0.0001;

const SCAN_INTERVAL_MS = 10000;
const DEADLINE_SECONDS = 6000;

const MAX_BATCH_SIZE = 1;
const MAX_CONCURRENT_SCANS = 12;

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

const usdcAbi = [
  "function balanceOf(address owner) view returns (uint256)"
];

const usdc = new ethers.Contract(
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  usdcAbi,
  provider
);

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

const routerContracts = Object.fromEntries(
  Object.values(routers).map(
    (addr) => [addr, new ethers.Contract(addr, routerAbi, provider)]
  )
);

/* ================= TOKENS ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeError(err) {
  return (
    err?.reason ||
    err?.shortMessage ||
    err?.info?.error?.message ||
    err?.message ||
    "Unknown error"
  );
}

async function logBalances() {

  const vaultUSDC = await usdc.balanceOf(VAULT_ADDRESS);
  const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);

  const maticBalance = await provider.getBalance(wallet.address);
  const formattedMatic = ethers.formatEther(maticBalance);

  console.log(`${CYAN}Vault USDC:${RESET} ${formattedVaultUSDC}`);
  console.log(`${CYAN}Wallet MATIC:${RESET} ${formattedMatic}`);
}

/* ================= QUOTE ================= */

async function quote(routerAddr, amountIn, path) {

  try {

    const router = routerContracts[routerAddr];

    const amounts = await router.getAmountsOut(amountIn, path);

    return amounts.at(-1);

  } catch {

    return null;

  }

}

/* ================= FIND ARB ================= */

async function findTrade(buyRouter, sellRouter, tokenAddr) {

  const usdcAddr = TOKENS.USDC;

  const amountIn =
    ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut;
  let bestBuyPath;

  const buyPaths = [
    [usdcAddr, tokenAddr],
    [usdcAddr, TOKENS.WMATIC, tokenAddr],
    [usdcAddr, TOKENS.WETH, tokenAddr]
  ];

  for (const p of buyPaths) {

    const out = await quote(buyRouter, amountIn, p);

    if (out && (!bestBuyOut || out > bestBuyOut)) {

      bestBuyOut = out;
      bestBuyPath = p;

    }

  }

  if (!bestBuyOut) return null;

  let bestSellOut;
  let bestSellPath;

  const sellPaths = [
    [tokenAddr, usdcAddr],
    [tokenAddr, TOKENS.WMATIC, usdcAddr],
    [tokenAddr, TOKENS.WETH, usdcAddr]
  ];

  for (const p of sellPaths) {

    const out = await quote(sellRouter, bestBuyOut, p);

    if (out && (!bestSellOut || out > bestSellOut)) {

      bestSellOut = out;
      bestSellPath = p;

    }

  }

  if (!bestSellOut) return null;

  const rawProfit =
    Number(ethers.formatUnits(bestSellOut, 6)) -
    MIN_TRADE_USDC;

  const profit = rawProfit - PROFIT_BUFFER;

  if (profit < MIN_EXPECTED_PROFIT)
    return null;

  console.log(
    `${GREEN}PROFIT FOUND:${RESET} ${profit.toFixed(6)}`
  );

  return {

    buyRouter,
    sellRouter,
    amountIn,
    bestBuyPath,
    bestSellPath

  };

}

/* ================= SCAN ================= */

async function scanTrades() {

  const tasks = [];

  for (const buy of Object.values(routers)) {

    for (const sell of Object.values(routers)) {

      if (buy === sell) continue;

      for (const token of Object.values(TOKENS)) {

        tasks.push(() =>
          findTrade(buy, sell, token)
        );

      }

    }

  }

  const results = [];

  while (tasks.length) {

    const batch =
      tasks.splice(0, MAX_CONCURRENT_SCANS);

    const res = await Promise.all(
      batch.map((fn) => fn())
    );

    for (const r of res)
      if (r) results.push(r);

  }

  return results;

}

/* ================= EXECUTE ================= */

async function executeBatch(trades) {

  if (!trades.length) {

    console.log("No valid trades");
    return;

  }

  const selected =
    trades.slice(0, MAX_BATCH_SIZE);

  console.log(
    `${YELLOW}Executing ${selected.length} trades${RESET}`
  );

  const deadline =
    Math.floor(Date.now() / 1000) +
    DEADLINE_SECONDS;

  const buyRouters =
    selected.map((t) => t.buyRouter);

  const sellRouters =
    selected.map((t) => t.sellRouter);

  const amounts =
    selected.map((t) => t.amountIn);

  const pathsToToken =
    selected.map((t) => t.bestBuyPath);

  const pathsToUSDC =
    selected.map((t) => t.bestSellPath);

  try {

    await vault.executeFlashBatchArbitrage.staticCall(
      buyRouters,
      sellRouters,
      amounts,
      pathsToToken,
      pathsToUSDC,
      deadline
    );

    const gas =
      await vault.executeFlashBatchArbitrage.estimateGas(
        buyRouters,
        sellRouters,
        amounts,
        pathsToToken,
        pathsToUSDC,
        deadline
      );

    const gasLimit =
      (gas * 120n) / 100n;

    const tx =
      await vault.executeFlashBatchArbitrage(
        buyRouters,
        sellRouters,
        amounts,
        pathsToToken,
        pathsToUSDC,
        deadline,
        { gasLimit }
      );

    console.log(
      `${GREEN}TX SENT:${RESET} ${tx.hash}`
    );

    await tx.wait();

    console.log(
      `${GREEN}BATCH SUCCESS${RESET}`
    );

  } catch (err) {

    console.log(
      `${RED}Execution failed:${RESET}`,
      decodeError(err)
    );

  }

}

/* ================= MAIN ================= */

async function main() {

  while (true) {

    await logBalances();

    const trades =
      await scanTrades();

    await executeBatch(trades);

    await sleep(SCAN_INTERVAL_MS);

  }

}

main().catch(console.error);
