import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= FORCE REAL-TIME LOG FLUSH ================= */
process.stdout._handle?.setBlocking?.(true);

function log(msg = "") {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

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

/* ================= CONSTANTS ================= */
const MIN_TRADE_USDC = 0.02;
const MIN_EXPECTED_PROFIT = 0.000001; // lowered to match contract (1 = 0.000001)

const MAX_BATCH_SIZE = 3;
const SCAN_INTERVAL_MS = 10000;
const DEADLINE_SECONDS = 60;

const MIN_BINARY = .2;
const MAX_BINARY = 25000;

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
const usdc = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const usdcContract = new ethers.Contract(
  usdc,
  ["function balanceOf(address owner) view returns (uint256)"],
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

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: usdc,
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logBalances() {
  const vaultUSDC = await usdcContract.balanceOf(VAULT_ADDRESS);
  const formattedVaultUSDC = ethers.formatUnits(vaultUSDC, 6);
  const maticBalance = await provider.getBalance(wallet.address);
  const formattedMatic = ethers.formatEther(maticBalance);

  log(`Vault USDC Balance: ${formattedVaultUSDC}`);
  log(`Wallet MATIC Balance: ${formattedMatic}\n`);
}

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= MICRO DETECTION ================= */
async function detectMicro(buyRouter, sellRouter, tokenAddr) {
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut, bestBuyPath;
  for (const p of [
    [usdc, tokenAddr],
    [usdc, TOKENS.WMATIC, tokenAddr],
    [usdc, TOKENS.WETH, tokenAddr],
    [usdc, TOKENS.USDT, tokenAddr],
    [usdc, TOKENS.DAI, tokenAddr]
  ]) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyOut) return null;

  let bestSellOut, bestSellPath;
  for (const p of [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ]) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }
  if (!bestSellOut) return null;

  const profit =
    Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return null;

  log(`Micro detection hit at 0.02 USDC`);
  log(`Initial gross profit (micro): ${profit.toFixed(6)} USDC`);

  return {
    buyRouter,
    sellRouter,
    path1: bestBuyPath,
    path2: bestSellPath
  };
}

/* ================= FIXED BINARY OPTIMIZER ================= */
async function binaryOptimize(trade) {
  log(`--- Binary Size Optimization Started ---\n`);

  let low = MIN_BINARY;
  let high = MAX_BINARY;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const amount = ethers.parseUnits(mid.toString(), 6);

    const out1 = await quote(trade.buyRouter, amount, trade.path1);
    if (!out1) {
      high = mid - 1;
      continue;
    }

    const out2 = await quote(trade.sellRouter, out1, trade.path2);
    if (!out2) {
      high = mid - 1;
      continue;
    }

    const flashFee = amount * 9n / 10000n;
    const netRaw = out2 - amount - flashFee;

    if (netRaw < 1n) {
      log(`Testing size: ${mid} USDC → FAIL (below minProfit)`);
      high = mid - 1;
      continue;
    }

    try {
      await vault.executeFlashBatchArbitrage.staticCall(
        [trade.buyRouter],
        [trade.sellRouter],
        [amount],
        [trade.path1],
        [trade.path2],
        Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
      );

      log(`Testing size: ${mid} USDC → PASS`);
      best = mid;
      low = mid + 1;
    } catch {
      log(`Testing size: ${mid} USDC → FAIL (contract revert)`);
      high = mid - 1;
    }
  }

  if (!best) return null;

  const amount = ethers.parseUnits(best.toString(), 6);

  const out1 = await quote(trade.buyRouter, amount, trade.path1);
  const out2 = await quote(trade.sellRouter, out1, trade.path2);

  const flashFee = amount * 9n / 10000n;

  const gasEstimate =
    await vault.executeFlashBatchArbitrage.estimateGas(
      [trade.buyRouter],
      [trade.sellRouter],
      [amount],
      [trade.path1],
      [trade.path2],
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );

  const gasPrice = await provider.getGasPrice();
  const gasCostWei = gasEstimate * gasPrice;

  const maticPriceUSDC = 0.10;
  const gasCostUSDC =
    Number(ethers.formatEther(gasCostWei)) * maticPriceUSDC;

  const gross =
    Number(ethers.formatUnits(out2 - amount - flashFee, 6));
  const net = gross - gasCostUSDC;

  log(`\nOptimal size found: ${best} USDC`);
  log(`Gross after flash fee: ${gross.toFixed(6)} USDC`);
  log(`Estimated gas cost: ${gasCostUSDC.toFixed(6)} USDC`);
  log(`Expected NET profit: ${net.toFixed(6)} USDC`);
  log(`-----------------------------------------\n`);

  return { ...trade, amountIn: amount };
}

/* ================= MAIN LOOP ================= */
async function main() {
  log("================= ARB BOT STARTED =================\n");

  while (true) {
    log("================= NEW SCAN =================\n");

    await logBalances();

    const optimizedTrades = [];

    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;

        for (const token of Object.values(TOKENS)) {
          const micro = await detectMicro(buy, sell, token);
          if (!micro) continue;

          const optimized = await binaryOptimize(micro);
          if (optimized) optimizedTrades.push(optimized);

          if (optimizedTrades.length === MAX_BATCH_SIZE) break;
        }
        if (optimizedTrades.length === MAX_BATCH_SIZE) break;
      }
      if (optimizedTrades.length === MAX_BATCH_SIZE) break;
    }

    if (optimizedTrades.length === 0) {
      log("No profitable trades found\n");
      await sleep(SCAN_INTERVAL_MS);
      continue;
    }

    const deadline =
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

    const tx = await vault.executeFlashBatchArbitrage(
      optimizedTrades.map(t => t.buyRouter),
      optimizedTrades.map(t => t.sellRouter),
      optimizedTrades.map(t => t.amountIn),
      optimizedTrades.map(t => t.path1),
      optimizedTrades.map(t => t.path2),
      deadline
    );

    log(`Batch flash sent: ${tx.hash}`);
    await tx.wait();
    log(`Batch flash confirmed — profits deposited to vault\n`);
  }
}

main().catch(err => {
  log(`FATAL ERROR: ${err.message}`);
});
