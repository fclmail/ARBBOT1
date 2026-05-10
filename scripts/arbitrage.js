import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const PRIVATE_KEY =
 process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

/* ================= NETWORK ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONFIG ================= */

const MODE = process.env.MODE || "FLASH";

const MIN_PROFIT_EXECUTE = ethers.parseUnits("0.000001", 6);
const SIGNAL_THRESHOLD = ethers.parseUnits("0.0001", 6);

const POLL_INTERVAL = 2000;

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS = "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const ABI = [
"function startAaveFlashArbitrage(address asset,uint256 amount,(address buyRouter,address sellRouter,address[] pathToToken,address[] pathToUSDC,uint256 deadline) route,uint256 minProfit)",
"function findBestFlashLoanSize(address buyRouter,address sellRouter,uint256[] candidateSizes,address[] pathToToken,address[] pathToUSDC) view returns(uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/* ================= ROUTERS ================= */

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= TOKENS ================= */

const TOKENS = {

USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",

WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",

USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",

DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",

WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",

CRV: "0x172370d5Cd63279eFa6d502DAB29171933a610AF"

};

/* ================= HELPERS ================= */

function sleep(ms) {
 return new Promise(r => setTimeout(r, ms));
}

/* ================= ROUTE BUILDER ================= */

function makeRoute(token, intermediate = null) {

 if (intermediate) {

  return {

   buyRouter: QUICKSWAP_ROUTER,

   sellRouter: SUSHISWAP_ROUTER,

   pathToToken: [TOKENS.USDC, intermediate, token],

   pathToUSDC: [token, intermediate, TOKENS.USDC],

   deadline: Math.floor(Date.now()/1000)+60

  };

 }

 return {

  buyRouter: QUICKSWAP_ROUTER,

  sellRouter: SUSHISWAP_ROUTER,

  pathToToken: [TOKENS.USDC, token],

  pathToUSDC: [token, TOKENS.USDC],

  deadline: Math.floor(Date.now()/1000)+60

 };

}

/* ================= SIZE TESTS ================= */

const candidateSizes = [

 ethers.parseUnits("1000",6),

 ethers.parseUnits("5000",6),

 ethers.parseUnits("10000",6),

 ethers.parseUnits("25000",6),

 ethers.parseUnits("50000",6),

 ethers.parseUnits("100000",6)

];

/* ================= PROFIT SCALER ================= */

async function simulateRoute(route) {

 const result = await vault.findBestFlashLoanSize(

  route.buyRouter,

  route.sellRouter,

  candidateSizes,

  route.pathToToken,

  route.pathToUSDC

 );

 return {

  amountIn: BigInt(result.amountIn),

  profit: BigInt(result.estimatedProfit)

 };

}

/* ================= SCANNER ================= */

async function scanRoutes() {

 console.log("🔎 Multi-hop scanning...");

 const tokens = Object.entries(TOKENS)
 .filter(([k]) => k !== "USDC");

 const intermediates = [
  TOKENS.USDT,
  TOKENS.DAI,
  TOKENS.WMATIC,
  TOKENS.WETH,
  TOKENS.WBTC
 ];

 let best = {
  token:null,
  route:null,
  size:0n,
  profit:0n
 };

 for (const [name,address] of tokens) {

  /* ===== DIRECT PATH ===== */

  const direct = makeRoute(address);

  const directSim = await simulateRoute(direct);

  console.log(
   `${name} direct profit:`,
   ethers.formatUnits(directSim.profit,6)
  );

  if (directSim.profit > best.profit) {

   best = {
    token:address,
    route:direct,
    size:directSim.amountIn,
    profit:directSim.profit
   };

  }

  /* ===== MULTI HOP ===== */

  for (const inter of intermediates) {

   if (inter === address) continue;

   const route = makeRoute(address, inter);

   const sim = await simulateRoute(route);

   console.log(
    `${name} via ${inter.slice(0,6)} profit:`,
    ethers.formatUnits(sim.profit,6)
   );

   if (sim.profit > best.profit) {

    best = {
     token:address,
     route,
     size:sim.amountIn,
     profit:sim.profit
    };

   }

  }

 }

 if (best.profit === 0n) {
  console.log("⚠️ No profitable route");
 }

 return best;

}

/* ================= EXECUTION ================= */

async function execute(best) {

 console.log("\n🔥 EXECUTING ARBITRAGE");

 console.log("Token:",best.token);

 console.log(
 "Size:",
 ethers.formatUnits(best.size,6)
 );

 console.log(
 "Expected Profit:",
 ethers.formatUnits(best.profit,6)
 );

 const tx = await vault.startAaveFlashArbitrage(

  TOKENS.USDC,

  best.size,

  best.route,

  MIN_PROFIT_EXECUTE

 );

 console.log("TX:",tx.hash);

 const receipt = await tx.wait();

 console.log("Confirmed block:",receipt.blockNumber);

}

/* ================= LOOP ================= */

async function main() {

 console.log("\n==================================");

 console.log("POLYGON ARBITRAGE BOT STARTED");

 console.log("==================================");

 console.log("Min Execute Profit:",ethers.formatUnits(MIN_PROFIT_EXECUTE,6));

 console.log("Signal Threshold:",ethers.formatUnits(SIGNAL_THRESHOLD,6));

 let cycle = 0;

 while(true){

  try{

   cycle++;

   console.log(`\n--- Cycle ${cycle} ---`);

   const best = await scanRoutes();

   if (best.profit > SIGNAL_THRESHOLD){

    console.log(
     "🔥 PROFIT SIGNAL:",
     ethers.formatUnits(best.profit,6)
    );

    await execute(best);

   } else {

    console.log(
     "💤 No trade (",
     ethers.formatUnits(best.profit,6),
     ")"
    );

   }

  }catch(e){

   console.log("Error:",e.message);

  }

  await sleep(POLL_INTERVAL);

 }

}

main();
