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
const MIN_EXPECTED_PROFIT = 0.000001; // min contract profit
const SCAN_INTERVAL_MS = 1000; // 1-second scan
const DEADLINE_SECONDS = 60;
const MAX_BATCH_SIZE = 8;

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

/* ================= USDC ABI ================= */
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

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
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

  console.log(`${CYAN}Vault USDC Balance:${RESET} ${formattedVaultUSDC}`);
  console.log(`${CYAN}Wallet MATIC Balance:${RESET} ${formattedMatic}`);
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

/* ================= ARBITRAGE ================= */
async function findProfitableTrade(buyRouter, sellRouter, tokenAddr) {
  const vaultUSDCBalance = await usdc.balanceOf(VAULT_ADDRESS);
  const vaultUSDCFloat = Number(ethers.formatUnits(vaultUSDCBalance, 6));

  // Dynamically scale: choose largest possible trade
  const SCALE_FACTORS = [8, 6, 4, 2, 1]; // descending
  let amountIn;
  for (const n of SCALE_FACTORS) {
    const proposedTrade = vaultUSDCFloat * n;
    if (proposedTrade > 0 && proposedTrade <= vaultUSDCFloat + 1) {
      amountIn = ethers.parseUnits(proposedTrade.toFixed(6), 6);
      break;
    }
  }
  if (!amountIn) amountIn = ethers.parseUnits("0.04", 6);

  const usdc = TOKENS.USDC;

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

  const profitRaw = bestSellOut - amountIn;
  const profit = ethers.formatUnits(profitRaw, 6);

  if (Number(profit) < MIN_EXPECTED_PROFIT) return null;

  console.log(
    `${GREEN}PROFIT FOUND:${RESET} Gross: ${profit} USDC | Trade size: ${ethers.formatUnits(amountIn, 6)} USDC`
  );

  return { buyRouter, sellRouter, amountIn, bestBuyPath, bestSellPath, profit: profitRaw };
}

/* ================= ATOMIC BATCH FLASH ================= */
async function batchArb() {
  await logBalances();

  const profitableTrades = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;
      for (const token of Object.values(TOKENS)) {
        const trade = await findProfitableTrade(buy, sell, token);
        if (trade) profitableTrades.push(trade);
        if (profitableTrades.length === MAX_BATCH_SIZE) break;
      }
      if (profitableTrades.length === MAX_BATCH_SIZE) break;
    }
    if (profitableTrades.length === MAX_BATCH_SIZE) break;
  }

  if (profitableTrades.length === 0) return console.log("No profitable trades found");

  console.log(`${YELLOW}Collected ${profitableTrades.length} profitable trades${RESET}`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const buyRouters = profitableTrades.map((t) => t.buyRouter);
  const sellRouters = profitableTrades.map((t) => t.sellRouter);
  const amountsInUSDC = profitableTrades.map((t) => t.amountIn);
  const pathsToToken = profitableTrades.map((t) => t.bestBuyPath);
  const pathsToUSDC = profitableTrades.map((t) => t.bestSellPath);

  try {
    console.log(
      `${CYAN}Executing batch (scaled to max vault & flash loan, min profit: ${MIN_EXPECTED_PROFIT} USDC)${RESET}`
    );

    await vault.executeFlashBatchArbitrage.staticCall(
      buyRouters,
      sellRouters,
      amountsInUSDC,
      pathsToToken,
      pathsToUSDC,
      deadline
    );

    console.log(`${CYAN}Batch static simulation passed${RESET}`);

    const estimatedGas = await vault.executeFlashBatchArbitrage.estimateGas(
      buyRouters,
      sellRouters,
      amountsInUSDC,
      pathsToToken,
      pathsToUSDC,
      deadline
    );

    const gasLimit = (estimatedGas * 120n) / 100n;

    console.log(`${CYAN}Batch gas estimate:${RESET} ${estimatedGas}`);

    const tx = await vault.executeFlashBatchArbitrage(
      buyRouters,
      sellRouters,
      amountsInUSDC,
      pathsToToken,
      pathsToUSDC,
      deadline,
      { gasLimit }
    );

    console.log(`${GREEN}Batch flash sent:${RESET} ${tx.hash}`);
    await tx.wait();
    console.log(`${GREEN}Batch flash confirmed — profits deposited to vault${RESET}`);

    await logBalances();
  } catch (err) {
    console.log(`${RED}Batch trade failed:${RESET}`, decodeError(err));
  }
}

/* ================= MAIN LOOP ================= */
async function main() {
  while (true) {
    await batchArb();
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
