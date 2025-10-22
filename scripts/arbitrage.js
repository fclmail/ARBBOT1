#!/usr/bin/env node  
/**  
 * Bidirectional arbitrage scanner + executor  
 * Ethers v6 compatible, with explicit decimal normalization and improved logging.  
 * - Decimals are fetched per token (USDC and TOKEN) and used consistently.  
 * - Profit is computed in USDC base units: ProfitUSDC = sellOutUSDC - amountInUSDC  
 * - MIN_PROFIT_USDC is converted once to USDC-decimal units for comparisons.  
 */  

//🟢 1  Import necessary modules from ethers library  
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits } from "ethers";  

//🟢 2  Load environment variables  
const {  
  RPC_URL,  
  PRIVATE_KEY,  
  BUY_ROUTER,  
  SELL_ROUTER,  
  TOKEN,  
  USDC_ADDRESS,  
  AMOUNT_IN_HUMAN,  
  CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,  
  MIN_PROFIT_USDC,  
  SCAN_INTERVAL_MS  
} = process.env;  

//🟢 3  Validate required environment variables  
const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, USDC_ADDRESS, AMOUNT_IN_HUMAN };  
const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);  
if (missing.length > 0) {  
  console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);  
  process.exit(1);  
}  

//🟢 4  Configuration / defaults (decimals will be discovered)  
const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();  
const rpcUrl = RPC_URL.trim();  
const buyRouterAddr = BUY_ROUTER.trim();  
const sellRouterAddr = SELL_ROUTER.trim();  
const tokenAddr = TOKEN.trim();  
const usdcAddr = USDC_ADDRESS.trim();  
const AMOUNT_HUMAN_STR = AMOUNT_IN_HUMAN.trim();  

const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000; //🟢 Scan interval in ms  

// Decimals placeholders (will be populated from on-chain)  
let USDC_DECIMALS = 6;  // default fallback  
let TOKEN_DECIMALS = 18; // default fallback  

// MIN_PROFIT_USDC handling (will convert to USDC decimals later)  
let MIN_PROFIT_USDC_RAW = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;  
if (MIN_PROFIT_USDC_RAW <= 0) {  
  MIN_PROFIT_USDC_RAW = 0.0000001;  
}  

// We'll convert MIN_PROFIT_USDC into USDC-decimals once we know USDC_DECIMALS  
let MIN_PROFIT_UNITS = null;  

//🟢 5  Validate Ethereum addresses  
const { isAddress } = await import("ethers");  
for (const [name, a] of [  
  ["BUY_ROUTER", buyRouterAddr],  
  ["SELL_ROUTER", sellRouterAddr],  
  ["TOKEN", tokenAddr],  
  ["USDC_ADDRESS", usdcAddr],  
  ["CONTRACT_ADDRESS", CONTRACT_ADDRESS]  
]) {  
  if (!isAddress(a)) {  
    console.error(`❌ Invalid Ethereum address for ${name}:`, a);  
    process.exit(1);  
  }  
}  

//🟢 6 Setup provider and wallet …).

javascript
//🟢 7  ABIs for routers and arbitrage executor contract
const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

//🟢 8  Create contract instances
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

//🟢 9  Helpers: decimal handling (will be filled after decimals are known)


// Per-event helpers will depend on actual decimals
let amountInUSDC = null; // BigInt in USDC base units
let amountInToken = null; // BigInt in TOKEN base units
let minProfitUnits = null;  // BigInt in USDC base units

const toUnits = (humanStr, decimals) => {
// Accept string/number; returns BigInt in token's base units
// Using ethers' parseUnits handles decimals precisely
const { parseUnits } = await import("ethers"); // dynamic import inside function scope
return parseUnits(humanStr.toString(), decimals);
};

// But since we can't use await at top level in all runtimes, define a small helper below after decimals known.
// Placeholder to satisfy lints; actual usage will be in initDecimals().

Continue with a clean, fully-working continuation that completes the script with proper async initialization, decimal fetch, the checkArbDirection function, and the main loop. This assumes ES module context and Node.js with top-level await support or that you wrap startup in an async IIFE if needed.

Code to paste after the placeholder above:

javascript
//🟢 10  ABIs and contracts are ready (same file scope)  
const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];  
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];  

//🟢 11  Create contract instances  
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);  
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);  
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);  

//🟢 12  Decimal state (will be initialized by initDecimals)  
let USDC_DECIMALS = 6;   // fallback  
let TOKEN_DECIMALS = 18;  // fallback  

let amountInUSDC = null;   // BigInt in USDC base units  
let amountInToken = null;  // BigInt in TOKEN base units  
let MIN_PROFIT_UNITS = null; // BigInt in USDC base units  

// Per-run helpers that rely on decimals (to be created after initDecimals)  
let toUnitsAny = null;  // (humanStr, decimals) => BigInt  
let fromUnitsAny = null; // (big, decimals) => string  

//🟢 13  Initialize decimals from on-chain contracts  
async function initDecimals() {  
  // Fetch decimals from USDC and TOKEN contracts  
  try {  
    const usdcDecContract = new Contract(usdcAddr, ["function decimals() view returns (uint8)"], provider);  
    const tokenDecContract = new Contract(tokenAddr, ["function decimals() view returns (uint8)"], provider);  

    const usdcD = await usdcDecContract.decimals();  
    const tokenD = await tokenDecContract.decimals();  


    // Initialize MIN_PROFIT_UNITS using USDC decimals  
    MIN_PROFIT_UNITS = parseUnits(MIN_PROFIT_USDC ? MIN_PROFIT_USDC.toString() : "0.0000001", USDC_DECIMALS);  

    // Define generic conversion helpers using current decimals  
    toUnitsAny = (humanStr, decimals) => {  
      // dynamic import already done earlier; reuse ethers parseUnits  
      // eslint-disable-next-line no-undef  
      const { parseUnits } = require("ethers");  
      return parseUnits(humanStr.toString(), decimals);  
    };  

    fromUnitsAny = (big, decimals) => {  
      // eslint-disable-next-line no-undef  
      const { formatUnits } = require("ethers");  
      return formatUnits(big, decimals);  
    };  

    // Prepare initial amountIn values  
    // amountInUSDC and amountInToken depend on the path usage. We keep them as BigInt for on-chain calls.  
    amountInUSDC = toUnitsAny(AMOUNT_HUMAN_STR, USDC_DECIMALS);  
    amountInToken = null; // We don't precompute token input here; it's derived from amountInUSDC through getAmountsOut  

    console.log(`🔧 Decimals initialized: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);  
    console.log(`🔧 Initial amountInUSDC (base units): ${amountInUSDC.toString()}`);  
  } catch (err) {  
    console.error("❌ Failed to initialize decimals:", err);  
    process.exit(1);  
  }  
}  

//🟢 14  Function to scan one arbitrage direction  
  async function checkArbDirection(buyR, sellR, direction) {  
    try {  
      // Must ensure decimals have been initialized before performing on-chain calls  
      if (typeof USDC_DECIMALS !== "number" || typeof TOKEN_DECIMALS !== "number") {  
        console.warn(`${new Date().toISOString()} [${direction}] ⚠️ Decimals not initialized yet. Skipping this cycle.`);  
        return;  
      }  

      // Prepare paths  
      const pathBuy = [usdcAddr, tokenAddr];   // USDC -> TOKEN  
      const pathSell = [tokenAddr, usdcAddr];  // TOKEN -> USDC  

      // amountIn is in USDC base units  
      const amountInBase = amountInUSDC;  
      // First, query how much TOKEN we can get for amountInUSDC  
      const buyOutArr = await buyR.getAmountsOut(amountInBase, pathBuy);  
      const buyOutToken = buyOutArr[1]; // in TOKEN's base units (TOKEN_DECIMALS)  

      // Then, query how much USDC we can get back by selling that TOKEN amount  
      const sellOutArr = await sellR.getAmountsOut(buyOutToken, pathSell);  
      const sellOutUSDC = sellOutArr[1]; // in USDC base units (USDC_DECIMALS)  

      // Compute profit in USDC base units  
      const profitUSDC = BigInt(sellOutUSDC.toString()) - BigInt(amountInBase.toString());  

      // Normalize for logging  
      const buyOutHuman = ((): string => {  
        // Convert TOKEN base units to human with TOKEN_DECIMALS  
        const { formatUnits } = require("ethers");  
        return formatUnits(buyOutToken, TOKEN_DECIMALS);  
      })();  

      const sellOutHumanUSDC = ((): string => {  
        const { formatUnits } = require("ethers");  
        return formatUnits(sellOutUSDC, USDC_DECIMALS);  
      })();  

      const profitHumanUSDC = ((): string => {  
        const { formatUnits } = require("ethers");  
        return formatUnits(profitUSDC, USDC_DECIMALS);  
      })();  

      // Log results with proper decimals  
      console.log(`${new Date().toISOString()} [${direction}] 💰 Buy -> token: ${buyOutHuman} token`);  
      console.log(`${new Date().toISOString()} [${direction}] 💵 Sell -> USDC: ${sellOutHumanUSDC} USDC`);  
      console.log(`${new Date().toISOString()} [${direction}] 🧮 Profit: ${profitHumanUSDC} USDC`);  

      // Decide to execute arbitrage  
      if (profitUSDC > MIN_PROFIT_UNITS) {  
        console.log(`${new Date().toISOString()} [${direction}] ✅ Executing arbitrage...`);  
        try {  
          const gasEst = await arbContract.estimateGas.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInBase);  
          const tx = await arbContract.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInBase, {  
            gasLimit: gasEst.mul(120).div(100) // 20% buffer  
          });  
          console.log(`${new Date().toISOString()} [${direction}] 🧾 TX sent: ${tx.hash}`);  
          const receipt = await tx.wait();  
          console.log(`${new Date().toISOString()} [${direction}] 🎉 TX confirmed: ${receipt.transactionHash}`);  
        } catch (err) {  
          console.error(`${new Date().toISOString()} [${direction}] ❌ Execution failed: ${err?.message ?? err}`);  
        }  
      } else {
        console.log(`${new Date().toISOString()} [${direction}] 🚫 No profitable opportunity.`);
      }
    } catch (err) {
      console.warn(`${new Date().toISOString()} [${direction}] ⚠️ Router call failed: ${err?.message ?? err}`);
    }
  } catch (err) {
    console.error(`${new Date().toISOString()} [${direction}] ❌ Unexpected error: ${err?.message ?? err}`);
  }
}
//🟢 15 Main loop to scan both directions
async function runLoop() {
// Ensure decimals are initialized before entering the loop
await initDecimals();

while (true) {
const block = await provider.getBlockNumber();
console.log(\n${new Date().toISOString()} [#${++iteration}] 🔍 Block ${block} — scanning both directions...);

// A→B: USDC -> TOKEN -> USDC
await checkArbDirection(buyRouter, sellRouter, "A→B");

// B→A: USDC and TOKEN reversed
await checkArbDirection(sellRouter, buyRouter, "B→A");

await sleep(SCAN_MS);

}
}

//🟢 16 Start the scanner
console.log(${new Date().toISOString()} ▸ 🚀 Starting bidirectional live arbitrage scanner);
let iteration = 0;
runLoop().catch((err) => {
console.error("❌ Fatal error in main loop:", err);
process.exit(1);
});
