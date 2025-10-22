#!/usr/bin/env node
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress } from "ethers";

const {
  RPC_URL,
  PRIVATE_KEY,
  BUY_ROUTER,
  SELL_ROUTER,
  TOKEN,
  AMOUNT_IN_HUMAN,
  USDC_ADDRESS,
  CONTRACT_ADDRESS: ENV_CONTRACT_ADDRESS,
  MIN_PROFIT_USDC,
  SCAN_INTERVAL_MS
} = process.env;

if (!RPC_URL || !PRIVATE_KEY || !BUY_ROUTER || !SELL_ROUTER || !TOKEN || !AMOUNT_IN_HUMAN || !USDC_ADDRESS) {
  console.error("Missing required environment variables!");
  process.exit(1);
}

const CONTRACT_ADDRESS = (ENV_CONTRACT_ADDRESS || "0x19B64f74553eE0ee26BA01BF34321735E4701C43").trim();
const buyRouterAddr = BUY_ROUTER.trim();
const sellRouterAddr = SELL_ROUTER.trim();
const tokenAddr = TOKEN.trim();
const usdcAddr = USDC_ADDRESS.trim();
const rpcUrl = RPC_URL.trim();
const AMOUNT_HUMAN = AMOUNT_IN_HUMAN.trim();
const DECIMALS = 6; 
const MIN_PROFIT = MIN_PROFIT_USDC ? Number(MIN_PROFIT_USDC) : 0.0000001;
const SCAN_MS = SCAN_INTERVAL_MS ? Number(SCAN_INTERVAL_MS) : 5000;

for (const [name, a] of [
  ["BUY_ROUTER", buyRouterAddr],
  ["SELL_ROUTER", sellRouterAddr],
  ["TOKEN", tokenAddr],
  ["CONTRACT_ADDRESS", CONTRACT_ADDRESS],
  ["USDC_ADDRESS", usdcAddr]
]) {
  if (!isAddress(a)) {
    console.error(`❌ Invalid Ethereum address for ${name}:`, a);
    process.exit(1);
  }
}

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(PRIVATE_KEY.trim(), provider);

const UNIV2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"];
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];
const buyRouter = new Contract(buyRouterAddr, UNIV2_ROUTER_ABI, provider);
const sellRouter = new Contract(sellRouterAddr, UNIV2_ROUTER_ABI, provider);
const arbContract = new Contract(CONTRACT_ADDRESS, ARB_ABI, wallet);

const toUnits = (humanStr) => parseUnits(humanStr, DECIMALS);
const fromUnits = (big) => formatUnits(big, DECIMALS);

const minProfitUnits = toUnits(MIN_PROFIT.toFixed(6));
const amountIn = toUnits(AMOUNT_HUMAN);

function now() { return new Date().toISOString(); }
console.log(`${now()} ▸ Starting live arbitrage scanner`);
console.log(`${now()} ▸ Config: contract=${CONTRACT_ADDRESS}, buyRouter=${buyRouterAddr}, sellRouter=${sellRouterAddr}, token=${tokenAddr}, amountIn=${AMOUNT_HUMAN}, minProfit=${MIN_PROFIT}`);

async function runLoop() {
  let iteration = 0;
  while (true) {
    iteration++;
    try {
      const block = await provider.getBlockNumber();
      console.log(`${now()} [#${iteration}] block=${block} — scanning...`);

      const pathBuy = [usdcAddr, tokenAddr];
      const pathSell = [tokenAddr, usdcAddr];

      const buyAmounts = await buyRouter.getAmountsOut(amountIn, pathBuy);
      const buyOut = buyAmounts[buyAmounts.length - 1];

      const sellAmounts = await sellRouter.getAmountsOut(buyOut, pathSell);
      const sellOut = sellAmounts[sellAmounts.length - 1];

      const profit = sellOut - amountIn;

      console.log(`${now()} [#${iteration}] buyAmount(token) = ${buyOut.toString()} (${fromUnits(buyOut)})`);
      console.log(`${now()} [#${iteration}] sellAmount(USDC) = ${sellOut.toString()} (${fromUnits(sellOut)})`);
      console.log(`${now()} [#${iteration}] profit raw = ${profit.toString()} (${fromUnits(profit)})`);

      if (profit >= minProfitUnits) {
        console.log(`${now()} [#${iteration}] Profit >= MIN_PROFIT — executing arbitrage...`);
        try {
          const gasEst = await arbContract.estimateGas.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn);
          const tx = await arbContract.executeArbitrage(buyRouterAddr, sellRouterAddr, tokenAddr, amountIn, { gasLimit: gasEst.mul(110).div(100) });
          console.log(`${now()} [#${iteration}] tx sent: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${now()} [#${iteration}] tx confirmed: ${receipt.transactionHash}`);
          console.log(`${now()} [#${iteration}] Arbitrage executed ✅ profit remains in contract`);
        } catch (err) {
          console.error(`${now()} [#${iteration}] Execution reverted or failed:`, err);
        }
      } else {
        console.log(`${now()} [#${iteration}] No profitable arbitrage (profit < MIN_PROFIT). Skipping.`);
      }
    } catch (err) {
      console.error(`${now()} [#${iteration}] Unexpected error:`, err);
    }
    await new Promise(res => setTimeout(res, SCAN_MS));
  }
}

runLoop().catch(err => { console.error("Fatal error:", err); process.exit(1); });
