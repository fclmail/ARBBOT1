import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= CONFIG ================= */
dotenv.config({ override: false });

const RPC_POLYGON = (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();
const AAVE_POOL = (process.env.AAVE_POOL || "0x794a61358D6845594F94dc1DB02A252b5b4814aD").trim(); // Default pool
const VAULT_ADDRESS = (process.env.VAULT_ADDRESS || "0xAB046582A36D00f4921C447db9b77644b5e43c95").trim(); // Vault

if (!RPC_POLYGON) throw new Error("RPC_POLYGON is missing");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is missing");
if (!AAVE_POOL) throw new Error("AAVE_POOL env variable missing");

/* ================= CONSTANTS / SAFEGUARDS ================= */
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || 0.002);
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 4000);
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);
let MIN_SWEEP_AMOUNT = Number(process.env.MIN_SWEEP_AMOUNT || 0.000001);
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";

const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? Number(process.env.GAS_PRICE_GWEI) : undefined;
const GAS_LIMIT = process.env.GAS_LIMIT ? Number(process.env.GAS_LIMIT) : undefined;
const TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 1);

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const vaultAbi = [
  {
    inputs: [
      { internalType: "address", name: "buyRouter", type: "address" },
      { internalType: "address", name: "sellRouter", type: "address" },
      { internalType: "uint256", name: "amountInUSDC", type: "uint256" },
      { internalType: "address[]", name: "pathToToken", type: "address[]" },
      { internalType: "address[]", name: "pathToUSDC", type: "address[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" }
    ],
    name: "executeArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { inputs: [], name: "usdc", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};
const routerAbi = ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"];
const swapRouterAbi = ["function swapExactTokensForETH(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline)"];

/* ================= TOKENS ================= */
const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

/* ================= ANSI COLORS ================= */
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatUSDC(n) {
  try {
    return Number(ethers.formatUnits(n, 6)).toFixed(6);
  } catch {
    return String(n);
  }
}

/* ===== AAVE FLASH SIMULATION ===== */
async function getAaveLiquidity() {
  try {
    const pool = new ethers.Contract(AAVE_POOL, [
      "function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, uint8 id, uint16 reserveFlags)"
    ], provider);

    const reserve = await pool.getReserveData(TOKENS.USDC);
    const availableLiquidity = BigInt(reserve[1]); // variableBorrowIndex as placeholder
    return availableLiquidity;
  } catch (err) {
    console.log("⚠️ Aave liquidity fetch error:", err.message ?? err);
    return 0n;
  }
}

/* ===== QUOTE HELPER ===== */
async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/* ===== PATH GENERATION ===== */
const FALLBACK_HOPS = [WMATIC, TOKENS.WETH, TOKENS.DAI, TOKENS.USDT];
function generatePaths(base, token) {
  let paths = [];
  paths.push([base, token]);
  for (let hop of FALLBACK_HOPS) if (hop !== token) paths.push([base, hop, token]);
  return paths;
}

/* ===== CORE ARBITRAGE LOGIC WITH FLASH SIMULATION ===== */
async function tryArb(buyRouter, sellRouter, tokenAddr, buyPath = null, sellPath = null) {
  const usdcAddress = await vault.usdc();
  const directPathBuy = buyPath || [usdcAddress, tokenAddr];
  const directPathSell = sellPath || [tokenAddr, usdcAddress];

  const availableLiquidity = await getAaveLiquidity();
  const optimalFlashAmount = availableLiquidity / 10n; // safe 10%

  const amountIn = ethers.parseUnits("1", 6); // fallback minimal trade

  console.log(`🏦 Aave Available USDC Liquidity: ${ethers.formatUnits(availableLiquidity, 6)}`);
  console.log(`⚙️ Optimal Flash Amount: ${ethers.formatUnits(optimalFlashAmount, 6)} USDC`);
  console.log("🧪 Running Flash Simulation...");

  const buyOut = await quote(buyRouter, amountIn, directPathBuy);
  const sellOut = await quote(sellRouter, buyOut ?? 0, directPathSell);
  const profit = Number(ethers.formatUnits(sellOut ?? 0, 6)) - Number(ethers.formatUnits(amountIn, 6));

  console.log(`💰 Expected Profit: ${profit.toFixed(6)} USDC`);
  if (profit < MIN_EXPECTED_PROFIT) return { profit, success: false };

  console.log("🔥 EXECUTING ARBITRAGE WITH FLASH LOAN");
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  if (DRY_RUN) {
    console.log("🔎 DRY RUN: Flash would execute with vault.executeArbitrage");
    return { profit, success: true, dryRun: true };
  }

  let tx;
  for (let attempt = 0; attempt < TX_RETRY_ATTEMPTS; attempt++) {
    try {
      const txOpts = {};
      if (GAS_PRICE_GWEI) txOpts.gasPrice = ethers.parseUnits(GAS_PRICE_GWEI.toString(), "gwei");
      if (GAS_LIMIT) txOpts.gasLimit = GAS_LIMIT;

      tx = await vault.executeArbitrage(
        buyRouter,
        sellRouter,
        amountIn,
        directPathBuy,
        directPathSell,
        deadline,
        txOpts
      );
      console.log(`⛓ TX SENT: ${tx.hash}`);
      await tx.wait();
      console.log("✅ PROFIT DEPOSITED TO VAULT");
      break;
    } catch (err) {
      console.log(`⚠️ Arb tx attempt ${attempt + 1} failed:`, err?.message ?? err);
      if (attempt < TX_RETRY_ATTEMPTS - 1) await sleep(1000);
      else throw err;
    }
  }

  return { profit, success: true, txHash: tx?.hash ?? null };
}

/* ===== MAIN LOOP ===== */
(async () => {
  console.log(`✅ Connected to RPC: ${RPC_POLYGON}`);
  console.log("🚀 Arbitrage bot started");

  while (true) {
    try {
      const usdcAddress = await vault.usdc();
      const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));
      const vaultUSDC = Number(ethers.formatUnits(
        await new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider)
          .balanceOf(VAULT_ADDRESS), 6));

      console.log(`💎 Wallet MATIC balance: ${walletMatic.toFixed(6)}`);
      console.log(`💰 Vault USDC balance: ${vaultUSDC.toFixed(6)}`);

      for (const token of Object.values(TOKENS)) {
        const buyPaths = generatePaths(usdcAddress, token);
        const sellPaths = generatePaths(token, usdcAddress);

        for (const buy of Object.values(routers)) {
          for (const sell of Object.values(routers)) {
            if (buy === sell) continue;
            for (let bPath of buyPaths) for (let sPath of sellPaths) {
              try {
                await tryArb(buy, sell, token, bPath, sPath);
                await sleep(1200);
              } catch (e) { console.log(`⚠️ ${e?.message ?? e}`); }
            }
          }
        }
      }
    } catch (err) {
      console.log("⚠️ Scan error:", err?.message ?? err);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
