// arbitrage.js  
import { ethers } from "ethers";  

// -------------------------  
// CONFIG / ENV  
// -------------------------  
const RPC_URL = process.env.RPC_URL;  
const PRIVATE_KEY = process.env.PRIVATE_KEY;  
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;  

// Routers and asset list (adjust per your environment)  
const BUY_ROUTER = process.env.BUY_ROUTER;   // e.g., UniswapV2Router02  
const SELL_ROUTER = process.env.SELL_ROUTER; // e.g., SushiswapRouter02  

// Amounts and thresholds (strings to preserve precision)  
const AMOUNT_IN_USDC = process.env.AMOUNT_IN || "0.1";       // in USDC units (e.g., 0.1 USDC)  
const MIN_PROFIT_USDC = process.env.MIN_PROFIT_USDC || "0.00001"; // minimum profit to execute  

// Optional: enable dry-run (no on-chain txs)  
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";  

// Optional: logging level  
const VERBOSE = (process.env.VERBOSE || "true").toLowerCase() === "true";  

// -------------------------  
// TOKEN LIST SAFEGUARD  
// -------------------------  
const TOKEN_LIST = process.env.TOKEN_LIST  
  ? JSON.parse(process.env.TOKEN_LIST)  
  : {  
      USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },  
      WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },  
      WBTC: { address: "0x1BFD67037B42Cf73acF2047067Bd4F2C47D9BfD6", decimals: 8 },  
      KLIMA: { address: "0x4e78011Ce80ee02d2c3e649Fb657e45898257815", decimals: 9 },  
      DAI: { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },  
      CRV: { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18 }  
    };  

// -------------------------  
// ROUTER ABI  
// -------------------------  
const routerAbi = [  
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"  
];  

// -------------------------  
// STOP FLAG  
// -------------------------  
let stopBot = false;  
process.on("SIGINT", () => {  
  console.log("Stopping bot...");  
  stopBot = true;  
});  

// -------------------------  
// PROVIDER / SIGNER  
// -------------------------  
if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS || !BUY_ROUTER || !SELL_ROUTER) {  
  throw new Error("Missing essential environment variables. Ensure RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, BUY_ROUTER, and SELL_ROUTER are set.");  
}  

const provider = new ethers.JsonRpcProvider(RPC_URL);  
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);  

// Contract ABI (minimal)  
const contractAbi = [  
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn) external",  
  "function withdrawProfit(address token) external"  
];  

const contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);  

// -------------------------  
// HELPERS  
// -------------------------  

async function getTokenDecimals(tokenAddress) {  
  if (!tokenAddress) throw new Error("Token address is undefined");  
  const token = new ethers.Contract(  
    tokenAddress,  
    ["function decimals() view returns (uint8)"],  
    provider  
  );  
  return await token.decimals();  
}  

async function getAmountOut(routerAddress, amountIn, path) {  
  const router = new ethers.Contract(routerAddress, routerAbi, provider);  
  try {  
    const amounts = await router.getAmountsOut(amountIn, path);  
    return amounts[amounts.length - 1];  
  } catch (e) {
    if (VERBOSE) console.error("getAmountsOut error:", e);
    return ethers.BigNumber.from(0);
  }
}

function normalizeAmount(amountBN, decimals) {
  // Return a JS number for reporting/decisions, but use BigNumber for math when possible
  const asString = ethers.formatUnits(amountBN, decimals);
  return Number(asString);
}

// Simple in-flight guard for on-chain calls
let inFlight = false;
async function safeExecuteArbitrage(tokenAddress, amountInUSDC, buyRouter, sellRouter) {
  if (inFlight) throw new Error("Re-entrancy guard: another arbitrage is in-flight");
  inFlight = true;
  try {
    if (DRY_RUN) {
      console.log(`[DRY-RUN] Would execute arbitrage for token ${tokenAddress} with amountInUSDC ${amountInUSDC}`);
      return { simulated: true, txHash: null };
    } else {
      const tx = await contract.executeArbitrage(buyRouter, sellRouter, tokenAddress, amountInUSDC, {
        gasLimit: 1000000
      });
      console.log(`✅ Transaction sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
      return { simulated: false, txHash: tx.hash, receipt };
    }
  } finally {
    inFlight = false;
  }
}

// -------------------------
// ARBITRAGE LOOP
// -------------------------
async function arbitrageLoop() {
  const amountInUSDC = ethers.parseUnits(AMOUNT_IN_USDC, 6);

  // Build a readable list from TOKEN_LIST
  const tokens = Object.entries(TOKEN_LIST);

  // Simple accounting for real-time profit reporting
  let tick = 0;

  while (!stopBot) {
    tick += 1;
    if (VERBOSE) console.log(`\n--- Scan cycle #${tick} ---`);

    for (const [symbol, meta] of tokens) {
      try {
        const tokenAddress = meta.address;
        const tokenDecimals = meta.decimals || (await getTokenDecimals(tokenAddress));

        // Paths
        const pathBuy = [TOKEN_LIST.USDC.address, tokenAddress];
        const pathSell = [tokenAddress, TOKEN_LIST.USDC.address];

        // RAW getAmountOut
        const buyAmountOutRaw = await getAmountOut(BUY_ROUTER, amountInUSDC, pathBuy);
        const sellAmountOutRaw = await getAmountOut(SELL_ROUTER, buyAmountOutRaw, pathSell);

        // Normalize (token decimals for the bought token, 6 for USDC)
        const buyAmountNorm = normalizeAmount(buyAmountOutRaw, tokenDecimals);
        const sellAmountNorm = normalizeAmount(sellAmountOutRaw, 6);

        // Profit in USDC (raw difference)
        const profitUSDC = sellAmountNorm - Number(AMOUNT_IN_USDC);

        // Real-time reporting
        if (VERBOSE) {
          console.log(
            `🔎 Token ${symbol} | BuyOut=${buyAmountNorm.toFixed(6)} ${symbol} | ` +
            `SellOut=${sellAmountNorm.toFixed(6)} USDC | Profit=${profitUSDC.toFixed(6)} USDC`
          );
        }

        // Decision to execute
        if (profitUSDC >= Number(MIN_PROFIT_USDC)) {
          console.log(`💰 Profit threshold met for ${symbol} (≈$${profitUSDC.toFixed(6)} USDC). Executing arbitrage...`);
          const result = await safeExecuteArbitrage(tokenAddress, amountInUSDC, BUY_ROUTER, SELL_ROUTER);
          if (result.simulated) {
            console.log("🔎 [DRY-RUN] Arbitrage simulated, no on-chain action taken.");
          } else {
            console.log(`✅ Arbitrage tx hash: ${result.txHash}`);
          }
        } else {
          if (VERBOSE) console.log(`⚠️ Profit below threshold for ${symbol}, skipping.`);
        }

      } catch (err) {
        console.error(`⚠️ Error processing ${symbol}: ${err?.message || err}`);
      }
    }

    // pause between cycles (adjust as needed)
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log("🛑 Bot stopped.");
}

// -------------------------
// START BOT
// -------------------------
(async () => {
  try {
    console.log("Starting arbitrage bot with the following config:");
    console.log(`- RPC URL: ${RPC_URL ? "SET" : "NOT SET"}`);
    console.log(`- BUY_ROUTER: ${BUY_ROUTER}`);
    console.log(`- SELL_ROUTER: ${SELL_ROUTER}`);
    console.log(`- CONTRACT_ADDRESS: ${CONTRACT_ADDRESS}`);
    console.log(`- AMOUNT_IN_USDC: ${AMOUNT_IN_USDC}`);
    console.log(`- MIN_PROFIT_USDC: ${MIN_PROFIT_USDC}`);
    console.log(`- DRY_RUN: ${DRY_RUN}`);
    await arbitrageLoop();
  } catch (err) {
    console.error("Fatal error:", err);
  }
})();
