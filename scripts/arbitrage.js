#!/usr/bin/env node
/**
 * Bidirectional arbitrage scanner + executor
 * Ethers v6 compatible, fixed BigNumber/parseUnits issues
 * Fully Node.js v20 compatible (no top-level await)
 */

//🟢1  Import necessary modules
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

//🟢2  Load environment variables
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

//🟢3  Validate required environment variables
const required = { RPC_URL, PRIVATE_KEY, BUY_ROUTER, SELL_ROUTER, TOKEN, USDC_ADDRESS, AMOUNT_IN_HUMAN };
const missing = Object.entries(required).filter(([_, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

//🟢4  Configuration / defaults
const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
const rpcUrl = RPC_URL.trim();
const buyRouterAddr = BUY_ROUTER.trim();
const sellRouterAddr = SELL_ROUTER.trim();
const tokenAddr = TOKEN.trim();
const usdcAddr = USDC_ADDRESS.trim();
const AMOUNT_HUMAN_STR = AMOUNT_IN_HUMAN.trim();
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

//🟢5  Validate Ethereum addresses
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

//🟢6  Provider and wallet
const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

//🟢7  ABIs
const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

//🟢8  Contract instances
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

//🟢9  Decimal placeholders
let USDC_DECIMALS = 6;
let TOKEN_DECIMALS = 18;
let MIN_PROFIT_UNITS = null;
let amountInUSDC = null;

//🟢10  Sleep helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const now = () => new Date().toISOString();

//🟢11  Initialize decimals and amounts
async function initDecimals() {
  try {
    const usdcDecContract = new Contract(usdcAddr, ["function decimals() view returns (uint8)"], provider);
    const tokenDecContract = new Contract(tokenAddr, ["function decimals() view returns (uint8)"], provider);

    USDC_DECIMALS = Number(await usdcDecContract.decimals());
    TOKEN_DECIMALS = Number(await tokenDecContract.decimals());

    const minProfitRaw = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;
    MIN_PROFIT_UNITS = parseUnits(minProfitRaw.toString(), USDC_DECIMALS);

    amountInUSDC = parseUnits(AMOUNT_HUMAN_STR, USDC_DECIMALS);

    console.log(`🔧 Decimals initialized: USDC=${USDC_DECIMALS}, TOKEN=${TOKEN_DECIMALS}`);
    console.log(`🔧 Initial amountInUSDC (base units): ${amountInUSDC.toString()}`);
  } catch (err) {
    console.error("❌ Failed to initialize decimals:", err);
    process.exit(1);
  }
}

//🟢12  Arbitrage check per direction
async function checkArbDirection(buyR, sellR, direction) {
  try {
    const pathBuy = [usdcAddr, tokenAddr];
    const pathSell = [tokenAddr, usdcAddr];

    const buyAmounts = await buyR.getAmountsOut(amountInUSDC, pathBuy);
    const buyOutToken = BigInt(buyAmounts[1].toString());

    const sellAmounts = await sellR.getAmountsOut(buyOutToken, pathSell);
    const sellOutUSDC = BigInt(sellAmounts[1].toString());

    const profitUSDC = sellOutUSDC - BigInt(amountInUSDC.toString());

    const buyOutHuman = formatUnits(buyOutToken, TOKEN_DECIMALS);
    const sellOutHuman = formatUnits(sellOutUSDC, USDC_DECIMALS);
    const profitHuman = formatUnits(profitUSDC, USDC_DECIMALS);

    console.log(`${now()} [${direction}] 💰 Buy -> token: ${buyOutHuman} token`);
    console.log(`${now()} [${direction}] 💵 Sell -> USDC: ${sellOutHuman} USDC`);
    console.log(`${now()} [${direction}] 🧮 Profit: ${profitHuman} USDC`);

    if (profitUSDC > MIN_PROFIT_UNITS) {
      console.log(`${now()} [${direction}] ✅ Executing arbitrage...`);
      try {
        const gasEst = await arbContract.estimateGas.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC);
        const tx = await arbContract.executeArbitrage(buyR.address, sellR.address, tokenAddr, amountInUSDC, { gasLimit: gasEst.mul(120).div(100) });
        console.log(`${now()} [${direction}] 🧾 TX sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`${now()} [${direction}] 🎉 TX confirmed: ${receipt.transactionHash}`);
      } catch (err) {
        console.error(`${now()} [${direction}] ❌ Execution failed: ${err?.message ?? err}`);
      }
    } else {
      console.log(`${now()} [${direction}] 🚫 No profitable opportunity.`);
    }
  } catch (err) {
    console.warn(`${now()} [${direction}] ⚠️ Router call failed: ${err?.message ?? err}`);
  }
}

//🟢13  Main loop
let iteration = 0;
async function runLoop() {
  await initDecimals();
  while (true) {
    iteration++;
    const block = await provider.getBlockNumber();
    console.log(`\n${now()} [#${iteration}] 🔍 Block ${block} — scanning both directions...`);

    await checkArbDirection(buyRouter, sellRouter, "A→B");
    await checkArbDirection(sellRouter, buyRouter, "B→A");

    await sleep(SCAN_MS);
  }
}

//🟢14  Start scanner
console.log(`${now()} ▸ 🚀 Starting bidirectional live arbitrage scanner`);
runLoop().catch((err) => {
  console.error("❌ Fatal error in main loop:", err);
  process.exit(1);
});

