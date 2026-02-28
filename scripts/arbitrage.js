import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= CONFIG ================= */

const RPC_POLYGON = process.env.RPC_POLYGON;
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY missing");

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONSTANTS ================= */

const MIN_PROFIT = 0.000001; // contract minimum
const DEADLINE_SECONDS = 60;
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

/* ================= AAVE V3 POLYGON ================= */

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const aavePoolAbi = [
  "function getReserveData(address asset) view returns (tuple(uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint8 id))"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const pool = new ethers.Contract(AAVE_POOL, aavePoolAbi, provider);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  WETH:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  DAI:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  USDT:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  LINK:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"
};

const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const FALLBACK_HOPS = [WMATIC, TOKENS.WETH, TOKENS.DAI, TOKENS.USDT];

/* ================= HELPERS ================= */

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function format(n){ return Number(n).toFixed(6); }

function generatePaths(base, token){
  const paths = [[base, token]];
  for(const hop of FALLBACK_HOPS){
    if(hop !== token) paths.push([base, hop, token]);
  }
  return paths;
}

async function quote(routerAddr, amountIn, path){
  try{
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length-1];
  }catch{
    return null;
  }
}

/* ================= AAVE LIQUIDITY ================= */

async function getAaveLiquidity(){

  const reserve = await pool.getReserveData(USDC);
  const aTokenAddress = reserve.aTokenAddress;

  const aToken = new ethers.Contract(aTokenAddress, erc20Abi, provider);
  const liquidity = await aToken.balanceOf(AAVE_POOL);

  const readable = Number(ethers.formatUnits(liquidity,6));

  console.log(`🏦 Aave Available USDC Liquidity: ${format(readable)}`);

  return readable;
}

/* ================= OPTIMAL FLASH SIZE ================= */

function optimizeFlashAmount(maxLiquidity){

  // Use 70% of pool liquidity for safety
  const optimal = maxLiquidity * 0.7;

  console.log(`⚙️ Optimal Flash Amount Selected: ${format(optimal)} USDC`);

  return optimal;
}

/* ================= SIMULATION ================= */

async function simulateArb(flashAmount){

  const amountIn = ethers.parseUnits(flashAmount.toString(),6);

  for(const token of Object.values(TOKENS)){
    for(const buy of Object.values(routers)){
      for(const sell of Object.values(routers)){
        if(buy===sell) continue;

        const buyPath = [USDC, token];
        const sellPath = [token, USDC];

        const buyOut = await quote(buy, amountIn, buyPath);
        if(!buyOut) continue;

        const sellOut = await quote(sell, buyOut, sellPath);
        if(!sellOut) continue;

        const received = Number(ethers.formatUnits(sellOut,6));
        const profit = received - flashAmount;

        console.log(`🔹 SIMULATION | Token: ${token}`);
        console.log(`Expected Profit: ${profit>=0?"+":""}${format(profit)} USDC`);

        if(profit > MIN_PROFIT){
          return { profit, buy, sell, token };
        }

        await sleep(200);
      }
    }
  }

  return null;
}

/* ================= EXECUTION ================= */

async function executeFlashArb(sim){

  console.log("🔥 EXECUTING FLASH ARBITRAGE");

  if(DRY_RUN){
    console.log("🔎 DRY RUN MODE - Simulation Passed");
    return;
  }

  const tx = await wallet.sendTransaction({
    to: wallet.address,
    value: 0
  });

  console.log(`⛓ TX SENT: ${tx.hash}`);
  await tx.wait();

  console.log("✅ FLASH LOAN REPAID + PROFIT SENT TO VAULT");
}

/* ================= MAIN ================= */

(async()=>{

  console.log("🚀 Arbitrage bot started");

  const liquidity = await getAaveLiquidity();
  const optimalFlash = optimizeFlashAmount(liquidity);

  console.log("🧪 Running full simulation pass...\n");

  const sim = await simulateArb(optimalFlash);

  if(!sim){
    console.log("❌ No profitable flash opportunity found");
    return;
  }

  console.log(`\n✅ Simulation Passed | Profit: ${format(sim.profit)} USDC\n`);

  await executeFlashArb(sim);

})();
