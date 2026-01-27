import { ethers } from "ethers";

/* ─────────────────────────────
   RPC + Signer
───────────────────────────── */
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

/* ─────────────────────────────
   Addresses (Polygon)
───────────────────────────── */
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHI_ROUTER     = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* Execution routers (V2-compatible only) */
const BUY_ROUTER  = SUSHI_ROUTER;
const SELL_ROUTER = SUSHI_ROUTER;

/* ─────────────────────────────
   ABIs
───────────────────────────── */
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external"
];

const sushiABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
];

/* ─────────────────────────────
   Contracts
───────────────────────────── */
const vault  = new ethers.Contract(VAULT_CONTRACT, vaultABI, wallet);
const sushi  = new ethers.Contract(SUSHI_ROUTER, sushiABI, provider);
const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, quoterABI, provider);

/* ─────────────────────────────
   Config
───────────────────────────── */
const TRADE_SIZE = ethers.parseUnits("0.8", 6);
const UNI_FEE = 3000;
const MIN_PROFIT_USDC = ethers.parseUnits("0.005", 6); // aggressive
const LOOP_MS = 1500; // fast graph scan

let executing = false;
let lastCycleProfitable = false;

/* ─────────────────────────────
   Helpers
───────────────────────────── */
const ts = () => new Date().toISOString();
const fmt = (n, d = 6) => Number(n).toFixed(d);

/* ─────────────────────────────
   Graph Cycle Check
───────────────────────────── */
async function checkGraphCycle() {
  if (executing) return;

  try {
    /* Edge 1: USDC → WMATIC (UNI V3 quote) */
    const wmaticOut = await quoter.quoteExactInputSingle.staticCall(
      USDC,
      WMATIC,
      UNI_FEE,
      TRADE_SIZE,
      0
    );

    /* Edge 2: WMATIC → USDC (SUSHI V2 quote) */
    const sushiOut = await sushi.getAmountsOut(
      wmaticOut,
      [WMATIC, USDC]
    );

    const usdcBack = sushiOut[1];
    const profit = usdcBack - TRADE_SIZE;

    const cycleValue = Number(usdcBack) / Number(TRADE_SIZE);

    if (cycleValue > 1 && profit >= MIN_PROFIT_USDC) {
      if (!lastCycleProfitable) {
        console.log(`[${ts()}] 📈 ARBITRAGE CONFIRMED`);
        console.log(`[${ts()}] UNI buy: ${fmt(Number(wmaticOut) / 1e18)} WMATIC`);
        console.log(`[${ts()}] SUSHI sell: ${fmt(Number(usdcBack) / 1e6)} USDC`);
        console.log(`[${ts()}] Net Profit: +${fmt(Number(profit) / 1e6)} USDC`);
        console.log(`[${ts()}] EXECUTING ON-CHAIN...`);
      }

      lastCycleProfitable = true;
      await executeArb();
    } else {
      lastCycleProfitable = false;
    }

  } catch (err) {
    console.error(`[${ts()}] ERROR`, err.reason || err.message || err);
  }
}

/* ─────────────────────────────
   Execute Arbitrage
───────────────────────────── */
async function executeArb() {
  if (executing) return;
  executing = true;

  try {
    const deadline = Math.floor(Date.now() / 1000) + 90;

    const tx = await vault.executeArbitrage(
      BUY_ROUTER,
      SELL_ROUTER,
      TRADE_SIZE,
      [USDC, WMATIC],
      [WMATIC, USDC],
      deadline,
      { gasLimit: 1_500_000 }
    );

    console.log(`[${ts()}] TX SENT: ${tx.hash}`);

    await tx.wait();

    console.log(`[${ts()}] TX CONFIRMED`);
    console.log(`[${ts()}] 💰 Profit sent to vault`);
    console.log("──────────────────────────────");

  } finally {
    executing = false;
  }
}

/* ─────────────────────────────
   Start Graph Loop
───────────────────────────── */
setInterval(checkGraphCycle, LOOP_MS);
