import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

/* ─────────────────────────────
   RPC + Wallet
───────────────────────────── */
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

/* ─────────────────────────────
   Addresses
───────────────────────────── */
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

// Routers
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ─────────────────────────────
   ABIs
───────────────────────────── */
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256)",
  "function routerAllowance(address) view returns (uint256)",
  "event ArbitrageExecuted(address,address,address,uint256,uint256,uint256,uint256)"
];

const routerABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external view returns (uint256)"
];

/* ─────────────────────────────
   Contracts
───────────────────────────── */
const vault = new ethers.Contract(VAULT_CONTRACT, vaultABI, wallet);
const sushi = new ethers.Contract(SUSHI_ROUTER, routerABI, provider);
const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, quoterABI, provider);

/* ─────────────────────────────
   Config
───────────────────────────── */
const TRADE_SIZE = ethers.parseUnits(".800", 6); // 800 USDC
const MIN_SPREAD = 0.01; // 0.01%
const UNI_FEE = 3000;
const LOOP_INTERVAL = 5000; // 5 seconds

/* ─────────────────────────────
   Candidate structure (off-chain confirmed)
───────────────────────────── */
let executionQueue = []; // Only confirmed trades go here

/* ─────────────────────────────
   Off-chain confirmation function
───────────────────────────── */
async function confirmArbitrage() {
  const ts = new Date().toISOString();
  try {
    // Sushi quote: USDC -> WMATIC
    const sushiOut = await sushi.getAmountsOut(
      TRADE_SIZE,
      [USDC, WMATIC]
    );
    const sushiPrice = Number(sushiOut[1]) / 1e18;

    // Uniswap V3 quote: USDC -> WMATIC
    const uniOut = await quoter.quoteExactInputSingle.callStatic(
      USDC,
      WMATIC,
      UNI_FEE,
      TRADE_SIZE,
      0
    );
    const uniPrice = Number(uniOut) / 1e18;

    const spread = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`[${ts}] UNI: ${uniPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] SUSHI: ${sushiPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] Spread: ${spread.toFixed(4)}%`);

    if (spread < MIN_SPREAD) {
      console.log(`[${ts}] ❌ No arbitrage`);
      console.log("──────────────────────────────");
      return;
    }

    // Off-chain static call to vault to ensure execution succeeds
    const deadline = Math.floor(Date.now() / 1000) + 120;

    const canExecute = await vault.executeArbitrage.callStatic(
      UNISWAP_V3_QUOTER,
      SUSHI_ROUTER,
      TRADE_SIZE,
      [USDC, WMATIC],
      [WMATIC, USDC],
      deadline
    );

    console.log(`[${ts}] ✅ Arbitrage CONFIRMED, adding to execution queue`);

    executionQueue.push({
      buyRouter: UNISWAP_V3_QUOTER,
      sellRouter: SUSHI_ROUTER,
      amountIn: TRADE_SIZE,
      pathToToken: [USDC, WMATIC],
      pathToUSDC: [WMATIC, USDC],
      deadline
    });

  } catch (err) {
    console.error(`[${ts}] ERROR confirming arbitrage:`, err.reason || err.message);
  }
}

/* ─────────────────────────────
   On-chain executor
───────────────────────────── */
async function executeArbitrageQueue() {
  const ts = new Date().toISOString();
  while (executionQueue.length > 0) {
    const arb = executionQueue.shift();
    try {
      console.log(`[${ts}] 💰 Executing confirmed arbitrage on-chain...`);

      const tx = await vault.executeArbitrage(
        arb.buyRouter,
        arb.sellRouter,
        arb.amountIn,
        arb.pathToToken,
        arb.pathToUSDC,
        arb.deadline,
        { gasLimit: 1_200_000 }
      );

      console.log(`[${ts}] TX SENT: ${tx.hash}`);
      const receipt = await tx.wait();

      console.log(`[${ts}] ✅ TX CONFIRMED: ${receipt.transactionHash}`);
      console.log(`[${ts}] 💰 Profit sent to vault`);
      console.log("──────────────────────────────");

    } catch (err) {
      console.error(`[${ts}] ❌ Execution error:`, err.reason || err.message);
    }
  }
}

/* ─────────────────────────────
   Main loop
───────────────────────────── */
async function mainLoop() {
  await confirmArbitrage();
  await executeArbitrageQueue();
}

// Run loop
setInterval(mainLoop, LOOP_INTERVAL);
