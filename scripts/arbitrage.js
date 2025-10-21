// scripts/arbitrage_execute.js
import 'dotenv/config';
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

/**
 * Requirements:
 * - Put your ABI at ./abi/AaveFlashArb.json
 * - .env must include: RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, AMOUNT_IN, MIN_PROFIT_USDC,
 *   BUY_ROUTER, SELL_ROUTER
 * - Optionally add PROTECTED_RPC_URL (Flashbots Protect or other MEV-relay) as a secret.
 *
 * Test carefully on a fork/testnet before mainnet usage.
 */

// -------- configuration & token list (same as before) --------
const TOKENS = {
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI:  { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  KLIMA:{ address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  QUICK:{ address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
  USDCe:{ address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 }
};

// ABIs
const routerV2Abi = ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"];
const quoterAbi = ["function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"];

// env & validation
const {
  RPC_URL,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  AMOUNT_IN,
  MIN_PROFIT_USDC,
  BUY_ROUTER,
  SELL_ROUTER,
  PROTECTED_RPC_URL // optional
} = process.env;

function ensureEnv() {
  const required = { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, AMOUNT_IN, MIN_PROFIT_USDC, BUY_ROUTER, SELL_ROUTER };
  for (const [k,v] of Object.entries(required)) {
    if (!v) {
      console.error(`Missing env: ${k}`);
      process.exit(1);
    }
  }
}
ensureEnv();

// providers
const provider = new ethers.JsonRpcProvider(RPC_URL);
// If user set PROTECTED_RPC_URL, we'll use it only for sending transactions
const protectedProvider = PROTECTED_RPC_URL ? new ethers.JsonRpcProvider(PROTECTED_RPC_URL) : null;

// contracts for quoting (read-only on main provider)
const buyRouter = new ethers.Contract(BUY_ROUTER, routerV2Abi, provider);
const sellRouter = new ethers.Contract(SELL_ROUTER, routerV2Abi, provider);
const quoterV3 = new ethers.Contract("0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6", quoterAbi, provider); // Uniswap v3 quoter public

// Load on-chain arbitrage contract
function loadAbi() {
  const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
  if (!fs.existsSync(abiPath)) throw new Error("ABI missing at ./abi/AaveFlashArb.json");
  return JSON.parse(fs.readFileSync(abiPath, "utf8")).abi;
}
const arbAbi = loadAbi();
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, provider);

// wallet(s)
const walletLocal = new ethers.Wallet(PRIVATE_KEY); // without provider for quick use
const walletWithProvider = walletLocal.connect(provider);
const walletProtected = protectedProvider ? walletLocal.connect(protectedProvider) : null;

// helpers
const AMOUNT_IN_BN = ethers.parseUnits(AMOUNT_IN, 6); // USDC.e decimals
const MIN_PROFIT_BN = ethers.parseUnits(MIN_PROFIT_USDC, 6);

const ZERO = 0n;

async function getV2AmountOut(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch (e) {
    return ZERO;
  }
}

async function getV3Quote(quoter, tokenIn, tokenOut, amountIn, fee = 3000) {
  try {
    const amountOut = await quoter.callStatic.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
    return amountOut;
  } catch {
    return ZERO;
  }
}

function formatUsdc(bn) { return Number(ethers.formatUnits(bn, 6)); }

async function estimateAndSend(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn) {
  // instantiate contract instances for gas estimation with chosen provider
  const contractForEstimate = arbContract.connect(provider); // estimate on main provider

  // First: simulation via callStatic to see if contract's logic will revert
  try {
    await contractForEstimate.callStatic.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn, {
      // callStatic doesn't change state, it will revert if execution would revert
    });
  } catch (simErr) {
    // callStatic reverted -> not safe to send tx
    throw new Error(`callStatic simulation reverted: ${simErr?.message || simErr}`);
  }

  // Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await contractForEstimate.estimateGas.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn);
  } catch (e) {
    throw new Error(`estimateGas failed: ${e?.message || e}`);
  }

  // Get current gas price info (EIP-1559 style)
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("1", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");

  // calculate cost = gasEstimate * maxFeePerGas
  const txCost = gasEstimate * maxFeePerGas;

  // Check wallet MATIC balance
  const senderAddress = walletWithProvider.address;
  const balance = await provider.getBalance(senderAddress);

  if (balance < txCost) {
    throw new Error(`insufficient MATIC balance: ${ethers.formatEther(balance)} < estimated tx cost ${ethers.formatEther(txCost)}`);
  }

  // Choose which provider/wallet to use to send the transaction:
  // If PROTECTED_RPC_URL provided, use walletProtected; else use walletWithProvider
  const senderWallet = walletProtected ?? walletWithProvider;

  // Prepare tx overrides
  const overrides = {
    gasLimit: gasEstimate * 1n + 20000n, // add small buffer
    maxFeePerGas,
    maxPriorityFeePerGas
  };

  // Send
  const contractForSend = new ethers.Contract(CONTRACT_ADDRESS, arbAbi, senderWallet);
  const tx = await contractForSend.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn, overrides);
  return tx;
}

// Main scanning + execution loop (single pass)
async function runOnce() {
  console.log("Starting arb scan + exec attempt (single pass)...");
  console.log(`AmountIn: ${AMOUNT_IN} USDC.e  MinProfit: ${MIN_PROFIT_USDC} USDC.e`);

  for (const [symbol, token] of Object.entries(TOKENS)) {
    if (symbol === "USDCe") continue;
    try {
      console.log(`\nChecking ${symbol}...`);

      // Get best buy quote (USDC -> token)
      const v2BuyA = await getV2AmountOut(buyRouter, AMOUNT_IN_BN, [TOKENS.USDCe.address, token.address]);
      const v2BuyB = await getV2AmountOut(sellRouter, AMOUNT_IN_BN, [TOKENS.USDCe.address, token.address]);
      const v3Buy = await getV3Quote(quoterV3, TOKENS.USDCe.address, token.address, AMOUNT_IN_BN);

      // choose smallest tokenOut for buy (we want cheapest cost of token)
      const tokenOutCandidates = [v2BuyA, v2BuyB, v3Buy].filter(x => x && x !== ZERO);
      if (tokenOutCandidates.length === 0) {
        console.log(`  No buy liquidity for ${symbol}`);
        continue;
      }
      let tokenOut = tokenOutCandidates.reduce((a,b) => a < b ? a : b);

      // Get best sell quote (token -> USDC) by asking routers how many USDC we get selling tokenOut
      const v2SellA = await getV2AmountOut(buyRouter, tokenOut, [token.address, TOKENS.USDCe.address]);
      const v2SellB = await getV2AmountOut(sellRouter, tokenOut, [token.address, TOKENS.USDCe.address]);
      const v3Sell = await getV3Quote(quoterV3, token.address, TOKENS.USDCe.address, tokenOut);

      const usdcOutCandidates = [v2SellA, v2SellB, v3Sell].filter(x => x && x !== ZERO);
      if (usdcOutCandidates.length === 0) {
        console.log(`  No sell liquidity for ${symbol}`);
        continue;
      }
      const usdcOut = usdcOutCandidates.reduce((a,b) => a > b ? a : b); // best (max) USDC we can get back

      // profit = usdcOut - amountIn
      const profitBn = usdcOut - AMOUNT_IN_BN;
      const profitFloat = Number(ethers.formatUnits(profitBn, 6));

      console.log(`  Estimated profit: ${profitFloat.toFixed(8)} USDC.e`);

      if (profitBn < MIN_PROFIT_BN) {
        console.log("  Profit below threshold - skipping");
        continue;
      }

      // SAFETY: run callStatic to confirm contract execution would succeed
      console.log("  Simulating on-chain execution with callStatic...");
      try {
        await arbContract.callStatic.executeArbitrage(BUY_ROUTER, SELL_ROUTER, token.address, AMOUNT_IN_BN, { from: walletWithProvider.address });
      } catch (simErr) {
        console.log("  Simulation failed (callStatic reverted) — skipping. Reason:", simErr?.message || simErr);
        continue;
      }

      // Estimate & send
      console.log("  Simulation OK. Estimating gas and submitting transaction...");
      const tx = await estimateAndSend(BUY_ROUTER, SELL_ROUTER, token.address, AMOUNT_IN_BN);
      console.log("  Submitted tx:", tx.hash);
      const receipt = await tx.wait();
      console.log("  Tx confirmed in block", receipt.blockNumber);
    } catch (err) {
      console.error("  Error for token", symbol, ":", err.message || err);
    }
  }
}

// Run once (or you can call repeatedly)
runOnce()
  .then(()=>console.log("Run complete"))
  .catch(e=>console.error("Fatal error:", e));
