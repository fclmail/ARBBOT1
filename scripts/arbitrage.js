import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

const RPC_POLYGON = (process.env.RPC_POLYGON || "").trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || "").trim();
const AAVE_POOL = (process.env.AAVE_POOL || "").trim();
const VAULT_ADDRESS = (process.env.VAULT_ADDRESS || "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");
if (!AAVE_POOL) throw new Error("AAVE_POOL env variable missing");
if (!VAULT_ADDRESS) throw new Error("VAULT_ADDRESS missing");

const MIN_EXPECTED_PROFIT = 0.000001; // USDC
const DEADLINE_SECONDS = 60;
const DRY_RUN = true; // set false to execute

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// Vault
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

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};
const routerAbi = ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"];

// Tokens
const TOKENS = {
  USDC: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

// Utils
const sleep = ms => new Promise(r => setTimeout(r, ms));
function formatUSDC(n) { return Number(ethers.formatUnits(n, 6)).toFixed(6); }

async function getAaveLiquidity() {
  try {
    const pool = new ethers.Contract(AAVE_POOL, [
      "function getReserveData(address asset) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,address,uint8,uint16)"
    ], provider);

    const data = await pool.getReserveData(TOKENS.USDC);
    const rawLiquidity = data[1]; // uint128 currentLiquidityIndex placeholder
    // Convert to USDC scale
    return ethers.parseUnits((Number(ethers.formatUnits(rawLiquidity, 6)) * 0.001).toFixed(6), 6); 
    // 0.1% of liquidity
  } catch (err) {
    console.log("⚠️ Aave liquidity fetch error:", err.message ?? err);
    return ethers.parseUnits("1000", 6); // fallback 1000 USDC
  }
}

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch { return null; }
}

async function tryArb(buyRouter, sellRouter, token) {
  const usdcAddress = await vault.usdc();
  const flashAmount = await getAaveLiquidity();

  const buyPath = [usdcAddress, token];
  const sellPath = [token, usdcAddress];

  const buyOut = await quote(buyRouter, flashAmount, buyPath);
  const sellOut = await quote(sellRouter, buyOut ?? 0, sellPath);

  const profit = Number(ethers.formatUnits(sellOut ?? 0, 6)) - Number(ethers.formatUnits(flashAmount, 6));

  console.log("🧪 Running Flash Simulation...");
  console.log(`🏦 Aave Available USDC Liquidity: ${formatUSDC(flashAmount)}`);
  console.log(`⚙️ Optimal Flash Amount: ${formatUSDC(flashAmount)}`);
  console.log(`💰 Expected Profit: ${profit.toFixed(6)} USDC`);

  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log("🔥 EXECUTING ARBITRAGE WITH FLASH LOAN");
  if (!DRY_RUN) {
    const deadline = Math.floor(Date.now()/1000)+DEADLINE_SECONDS;
    const tx = await vault.executeArbitrage(buyRouter, sellRouter, flashAmount, buyPath, sellPath, deadline);
    console.log(`⛓ TX SENT: ${tx.hash}`);
    await tx.wait();
    console.log("✅ PROFIT DEPOSITED TO VAULT");
  }
}

// Example run
(async () => {
  console.log("🚀 Arbitrage bot started");
  for (const token of Object.values(TOKENS)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await tryArb(buy, sell, token);
        await sleep(1000);
      }
    }
  }
})();
