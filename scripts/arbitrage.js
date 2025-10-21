// arbitrage.js
// Self-contained example: gross profit reporting, logs exact cycle messages

require('dotenv').config();
const { ethers } = require('ethers');

// ---------------------- Config / Constants ----------------------

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const LOG_VERBOSE = (process.env.LOG_VERBOSE || 'true').toLowerCase() === 'true';

// Profit threshold (in USDC)
const MIN_PROFIT_USDC = parseFloat(process.env.MIN_PROFIT_USDC || '0.01'); 

// Starting trade amount (USDC)
let baseAmountInUSDC = parseFloat(process.env.INITIAL_AMOUNT_IN_USDC || '0.1');

// Token list
const TOKENS = [
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  // Add more tokens if needed
];

// Addresses
const USDC_ADDRESS = ethers.utils.getAddress(process.env.USDC_ADDRESS || '0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48');
const BUY_ROUTER_ADDRESS = ethers.utils.getAddress(process.env.BUY_ROUTER_ADDRESS || '0xUniswapV2Router02Address'); 
const SELL_ROUTER_ADDRESS = ethers.utils.getAddress(process.env.SELL_ROUTER_ADDRESS || '0xUniswapV2Router02Address'); 

// RPC provider
const PROVIDER_URL = process.env.PROVIDER_URL || 'https://mainnet.infura.io/v3/your-project-id';
const provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);

// Wallet
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error('Please set PRIVATE_KEY in env');
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Routers
const routerABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];
const buyRouter = new ethers.Contract(BUY_ROUTER_ADDRESS, routerABI, wallet);
const sellRouter = new ethers.Contract(SELL_ROUTER_ADDRESS, routerABI, wallet);

// ---------------------- Helpers ----------------------

function toBigNumber(val, decimals) {
  return ethers.parseUnits(val.toString(), decimals);
}

function fromBigNumber(bn, decimals) {
  return parseFloat(ethers.formatUnits(bn, decimals));
}

async function getAmountsOutForPath(router, amountInWei, path) {
  try {
    const amounts = await router.getAmountsOut(amountInWei, path);
    return amounts;
  } catch (err) {
    console.error('Error in getAmountsOutForPath:', err);
    throw err;
  }
}

// Logging helpers
function logCycleHeader(cycle) { console.log(`--- Scan cycle #${cycle} ---`); }
function logEvaluating(amountInUSDC) { console.log(`Cycle N: evaluating with amountInUSDC = ${amountInUSDC} USDC`); }
function logGrossProfit(tokenSymbol, profitUSDC) { console.log(`💰 Gross profit threshold met for ${tokenSymbol} (≈$${profitUSDC.toFixed(6)} USDC). Executing arbitrage...`); }
function logTxSent(txHash) { console.log(`✅ Transaction sent: ${txHash}`); }
function logTxConfirmed(blockNumber) { console.log(`✅ Transaction confirmed in block ${blockNumber}`); }
function logCycleComplete(tokenSymbol, grossProfitUSDC, amountInUSDC) { console.log(`🔎 Arbitrage cycle complete for ${tokenSymbol}: grossProfitUSDC=${grossProfitUSDC.toFixed(6)}, amountInUSDC=${amountInUSDC.toFixed(6)}`); }

// ---------------------- Arbitrage Logic ----------------------

let cycle = 1;
let currentAmountInUSDC = baseAmountInUSDC;
let shouldContinue = true;

async function runOneCycle(token) {
  const symbol = token.symbol;
  const tokenAddress = ethers.utils.getAddress(token.address);
  const tokenDecimals = token.decimals;

  const usdcAddress = ethers.utils.getAddress(USDC_ADDRESS);
  const pathBuy = [usdcAddress, tokenAddress];
  const pathSell = [tokenAddress, usdcAddress];

  const amountInUSDCWei = toBigNumber(currentAmountInUSDC, 6);

  let buyAmountsOut;
  try {
    buyAmountsOut = await getAmountsOutForPath(buyRouter, amountInUSDCWei, pathBuy);
  } catch (e) {
    console.warn(`Skipping ${symbol} due to buy path error:`, e);
    return null;
  }

  const tokenBoughtAmountWei = buyAmountsOut[1];
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

  const buyAmountOutNorm = fromBigNumber(tokenBoughtAmountWei, tokenDecimals);
  const sellAmountOutNorm = fromBigNumber(sellAmountsOut[1], 6);

  const grossProfitUSDC = sellAmountOutNorm - currentAmountInUSDC;

  if (LOG_VERBOSE) {
    console.log(`--- ${symbol} ---`);
    console.log(` Buy: ${currentAmountInUSDC.toFixed(6)} USDC -> ${buyAmountOutNorm.toFixed(tokenDecimals)} ${symbol}`);
    console.log(` Sell: ${buyAmountOutNorm.toFixed(tokenDecimals)} ${symbol} -> ${sellAmountOutNorm.toFixed(6)} USDC`);
    console.log(` GrossProfitUSDC ≈ ${grossProfitUSDC.toFixed(6)}`);
  }

  if (grossProfitUSDC >= MIN_PROFIT_USDC) {
    logGrossProfit(symbol, grossProfitUSDC);

    if (DRY_RUN) {
      console.log(`🔎 [DRY-RUN] Would execute arbitrage for ${symbol}.`);
    } else {
      try {
        // Placeholder for actual execution
        const txHash = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
        logTxSent(txHash);

        const mockBlockNumber = 12345678;
        logTxConfirmed(mockBlockNumber);

        logCycleComplete(symbol, grossProfitUSDC, currentAmountInUSDC);
      } catch (err) {
        console.error(`Arbitrage execution failed for ${symbol}:`, err);
      }
    }
  } else {
    console.log(`⚠️ Profit below threshold for ${symbol}, skipping. (GrossProfitUSDC=${grossProfitUSDC.toFixed(6)} USDC)`);
  }

  return { token: symbol, amountInUSDC: currentAmountInUSDC, grossProfitUSDC };
}

// ---------------------- Main Runner ----------------------

(async () => {
  while (shouldContinue) {
    logCycleHeader(cycle);
    for (const token of TOKENS) {
      await runOneCycle(token);
    }
    cycle += 1;

    if (cycle > 100) shouldContinue = false;
  }
  console.log('Arbitrage loop terminated.');
})();
