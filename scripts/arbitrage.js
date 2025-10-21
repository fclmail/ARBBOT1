// arbitrage.js  
// A self-contained example implementing gross profit reporting (no router fees deduction)  
// and logs the exact cycle messages you requested.  

require('dotenv').config();  
const { ethers } = require('ethers');  

// ---------------------- Config / Constants ----------------------  

// Basic settings  
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';  
const LOG_VERBOSE = (process.env.LOG_VERBOSE || 'true').toLowerCase() === 'true';  

// Profit threshold (in USDC, since input is USDC)  
const MIN_PROFIT_USDC = parseFloat(process.env.MIN_PROFIT_USDC || '0.01'); // adjust as needed  

// Starting trade amount (USDC)  
let baseAmountInUSDC = parseFloat(process.env.INITIAL_AMOUNT_IN_USDC || '0.1');  

// Token list (example; replace with your real tokens)  
const TOKENS = [  
  // Example: WETH (wrapped ETH) as a token with 18 decimals  
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },  
  // Add more tokens as needed  
  // { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },  
];  

// Addresses (examples; replace with real addresses in your network)  
const USDC_ADDRESS = ethers.utils.getAddress(process.env.USDC_ADDRESS || '0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48'); // USDC  
const BUY_ROUTER_ADDRESS = ethers.utils.getAddress(process.env.BUY_ROUTER_ADDRESS || '0xUniswapV2Router02Address'); // replace  
const SELL_ROUTER_ADDRESS = ethers.utils.getAddress(process.env.SELL_ROUTER_ADDRESS || '0xUniswapV2Router02Address'); // replace  
const ARB_CONTRACT_ADDRESS = process.env.ARB_CONTRACT_ADDRESS  
  ? ethers.utils.getAddress(process.env.ARB_CONTRACT_ADDRESS)  
  : null; // optional, if you call a dedicated arb contract  

// RPC provider  
const PROVIDER_URL = process.env.PROVIDER_URL || 'https://mainnet.infura.io/v3/your-project-id';  
const provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);  

// Signer (wallet)  
const PRIVATE_KEY = process.env.PRIVATE_KEY;  
if (!PRIVATE_KEY) throw new Error('Please set PRIVATE_KEY in env');  
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);  

// Routers (assuming UniswapV2-like)  
const buyRouter = new ethers.Contract(BUY_ROUTER_ADDRESS, [  
  // minimal ABI for getAmountsOut and swap (adjust to your router)  
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',  
  // you may need actual swap functions; for this script we assume a two-step approach via this router  
], wallet);  



//(((((((((((((((((((   connect where clarify    part 1 continued part to show connected   )))))))))))))


//part 2.


// Continuing arbitrage.js from the provided line  

const sellRouterABI = [  
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',  
  // You can add swap functions here if you intend to call the market, but this script uses getAmountsOut only for estimation  
];  
const sellRouter = new ethers.Contract(SELL_ROUTER_ADDRESS, sellRouterABI, wallet);  

// Utility helpers  
function toBigNumber(val, decimals) {  
  // val is a number or string in human units; convert to token's smallest unit  
  return ethers.utils.parseUnits(val.toString(), decimals);  
}  
function fromBigNumber(bn, decimals) {  
  return parseFloat(ethers.utils.formatUnits(bn, decimals));  
}  

async function getAmountsOutForPath(router, amountInWei, path) {  
  // amountInWei: BigNumber  
  // path: array of addresses  
  try {  
    const amounts = await router.getAmountsOut(amountInWei, path);  
    return amounts; // array of BigNumber  
  } catch (err) {  
    console.error('Error in getAmountsOutForPath:', err);  
    throw err;  
  }  
}  

// Logging helpers  
function logCycleHeader(cycle) {  
  console.log(`--- Scan cycle #${cycle} ---`);  
}  
function logEvaluating(amountInUSDC) {  
  console.log(`Cycle N: evaluating with amountInUSDC = ${amountInUSDC} USDC`);  
}  
function logGrossProfit(tokenSymbol, profitUSDC) {  
  console.log(`💰 Gross profit threshold met for ${tokenSymbol} (≈$${profitUSDC.toFixed(6)} USDC). Executing arbitrage...`);  
}  
function logTxSent(txHash) {  
  console.log(`✅ Transaction sent: ${txHash}`);  
}  
function logTxConfirmed(blockNumber) {  
  console.log(`✅ Transaction confirmed in block ${blockNumber}`);  
}  
function logCycleComplete(tokenSymbol, grossProfitUSDC, amountInUSDC) {  
  console.log(`🔎 Arbitrage cycle complete for ${tokenSymbol}: grossProfitUSDC=${grossProfitUSDC.toFixed(6)}, amountInUSDC=${amountInUSDC.toFixed(6)}`);  
}  

// Main loop state  
let cycle = 1;  
let currentAmountInUSDC = baseAmountInUSDC; // starting amount  
let shouldContinue = true;  

// You may want a ramp logic; for simplicity, we’ll loop tokens in TOKENS array  
async function runOneCycle(token) {  
  const symbol = token.symbol;  
  const tokenAddress = ethers.utils.getAddress(token.address);  
  const tokenDecimals = token.decimals;  

  // Paths  
  const usdcAddress = ethers.utils.getAddress(USDC_ADDRESS);  
  // Path for buy: USDC -> token  
  const pathBuy = [usdcAddress, tokenAddress];  
  // Path for sell: token -> USDC  
  const pathSell = [tokenAddress, usdcAddress];  

  // 1) Compute buy amount (USDC -> token)  
  const amountInUSDCWei = ethers.utils.parseUnits(currentAmountInUSDC.toFixed(6), 6);  
  let buyAmountsOut;  
  try {  
    buyAmountsOut = await getAmountsOutForPath(buyRouter, amountInUSDCWei, pathBuy);  
  } catch (e) {  
    console.warn(`Skipping ${symbol} due to buy path error:`, e);  
    return null;  
  }  

  // 2) Compute sell amount (token -> USDC) using the token amount from buy path  
  const tokenBoughtAmountWei = buyAmountsOut && buyAmountsOut.length > 1 ? buyAmountsOut[1] : null;  
  if (!tokenBoughtAmountWei) {  
    console.warn(`No buy output for ${symbol}, skipping.`);  
    return null;  
  }  
  let sellAmountsOut;  
  try {  
    sellAmountsOut = await getAmountsOutForPath(sellRouter, tokenBoughtAmountWei, pathSell);  
  } catch (e) {
    console.warn(`Skipping ${symbol} due to sell path error:`, e);
    return null;
  }

  // 3) Normalize outputs to human-friendly values (gross profit basis)
  // buyAmountsOut[1] is the amount of token bought (in token decimals)
  const buyAmountOutRaw = buyAmountsOut[1];
  // sellAmountsOut[1] is the amount of USDC received (in USDC decimals)
  const sellAmountOutRaw = sellAmountsOut[1];

  // Convert to human units
  const buyAmountOutNorm = fromBigNumber(buyAmountOutRaw, tokenDecimals);
  const sellAmountOutNorm = fromBigNumber(sellAmountOutRaw, 6); // USDC decimals

  // Gross profit in USDC: sellAmountOutNorm - amountInUSDC
  const grossProfitUSDC = sellAmountOutNorm - currentAmountInUSDC;

  // Logging per-cycle evaluation
  if (LOG_VERBOSE) {
    console.log(`--- ${token.symbol} ---`);
    console.log(` Buy: ${currentAmountInUSDC.toFixed(6)} USDC -> ${buyAmountOutNorm.toFixed(tokenDecimals)} ${token.symbol}`);
    console.log(` Sell: ${buyAmountOutNorm.toFixed(tokenDecimals)} ${token.symbol} -> ${sellAmountOutNorm.toFixed(6)} USDC`);
    console.log(` GrossProfitUSDC ≈ ${grossProfitUSDC.toFixed(6)}`);
  }

  // 4) Check against threshold
  if (grossProfitUSDC >= MIN_PROFIT_USDC) {
    // Log and proceed to execute (or DRY_RUN)
    logGrossProfit(symbol, grossProfitUSDC);

    if (DRY_RUN) {
      console.log(`🔎 [DRY-RUN] Would execute arbitrage for ${symbol}.`);
    } else {
      // 5) Execute arbitrage via on-chain path
      // This is a placeholder for your actual on-chain call.
      // You'd typically call your arb contract or perform two swaps in sequence.
      try {
        // Example: pretend we send a tx and get a txHash
        const txHash = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
        logTxSent(txHash);

        // If you wait for receipt, you'd fetch the receipt here and log blockNumber
        // For demonstration, simulate a receipt:
        const mockBlockNumber = 12345678;
        logTxConfirmed(mockBlockNumber);

        // Final per-cycle log
        logCycleComplete(symbol, grossProfitUSDC, currentAmountInUSDC);
      } catch (err) {
        console.error(`Arbitrage execution failed for ${symbol}:`, err);
      }
    }
  } else {
    // Not profitable enough this cycle
    console.log(`⚠️ Profit below threshold for ${symbol}, skipping. (GrossProfitUSDC=${grossProfitUSDC.toFixed(6)} USDC)`);
    // You may decide to adjust ramp or amount here
  }

  // 6) Prepare for next cycle
  // Depending on your loop logic, you might advance to next token or repeat with same token
  return {
    token: symbol,
    amountInUSDC: currentAmountInUSDC,
    grossProfitUSDC,
  };
}

// Main runner
(async () => {
  // Add a simple loop over TOKENS, one cycle per token
  while (shouldContinue) {
    for (const token of TOKENS) {
      const result = await runOneCycle(token);
      // Optional: ramp logic or cycle increment
      // Example: advance to next token after each full pass, or keep same
      // For demonstration, we'll just log and continue
    }
    cycle += 1;
    // Optional break condition for demo; remove in real bot
    if (cycle > 100) shouldContinue = false;
  }
  console.log('Arbitrage loop terminated.');
})();



















