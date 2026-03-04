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
const MIN_TRADE_USDC = 10000;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;
const MAX_BATCH_SIZE = 3;

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

/* ================= USDC ABI (FOR VAULT BALANCE) ================= */
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
 Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
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
LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", 
AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", 
AXLUSDC: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", 
BETA: "0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde", 
BONE: "0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e", 
DPI: "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b", 
FND: "0x292c4eefdda27062049d44d4730d5fe774b5f4c7", 
FREE: "0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238", 
KLIMA: "0x4e78011ce80ee02d2c3e649fb657e45898257815", 
LDO: "0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4", 
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
XSGD: "0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0"
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
  const usdc = TOKENS.USDC;
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

  console.log(
    `${GREEN}PROFIT FOUND:${RESET} Gross: ${profit.toFixed(6)} USDC`
  );

  return { buyRouter, sellRouter, amountIn, bestBuyPath, bestSellPath };
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

  if (profitableTrades.length === 0)
    return console.log("No profitable trades found");

  console.log(
    `${YELLOW}Collected ${profitableTrades.length} profitable trades${RESET}`
  );

  const deadline =
    Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const buyRouters = profitableTrades.map((t) => t.buyRouter);
  const sellRouters = profitableTrades.map((t) => t.sellRouter);
  const amountsInUSDC = profitableTrades.map((t) => t.amountIn);
  const pathsToToken = profitableTrades.map((t) => t.bestBuyPath);
  const pathsToUSDC = profitableTrades.map((t) => t.bestSellPath);

  try {

    console.log(
      `${CYAN}Executing batch (min contract profit: 0.000001 USDC)${RESET}`
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

    const estimatedGas =
      await vault.executeFlashBatchArbitrage.estimateGas(
        buyRouters,
        sellRouters,
        amountsInUSDC,
        pathsToToken,
        pathsToUSDC,
        deadline
      );

    const gasLimit = (estimatedGas * 120n) / 100n;

    console.log(
      `${CYAN}Batch gas estimate:${RESET} ${estimatedGas}`
    );

    const tx =
      await vault.executeFlashBatchArbitrage(
        buyRouters,
        sellRouters,
        amountsInUSDC,
        pathsToToken,
        pathsToUSDC,
        deadline,
        { gasLimit }
      );

    console.log(
      `${GREEN}Batch flash sent:${RESET} ${tx.hash}`
    );

    await tx.wait();

    console.log(
      `${GREEN}Batch flash confirmed — profits deposited to vault${RESET}`
    );

    await logBalances();

  } catch (err) {
    console.log(
      `${RED}Batch trade failed:${RESET}`,
      decodeError(err)
    );
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
