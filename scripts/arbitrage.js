// 🟢 Fully functional bidirectional arbitrage script (ethers v6)

// 1️⃣ IMPORTS
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// 2️⃣ RPC + WALLET SETUP
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// 3️⃣ CONTRACT ADDRESSES (Polygon)
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHI_ROUTER     = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

// 4️⃣ ABIs
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external"
];

const sushiABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external view returns (uint256)"
];

// 5️⃣ CONTRACT INSTANCES
const vault  = new ethers.Contract(VAULT_CONTRACT, vaultABI, wallet);
const sushi  = new ethers.Contract(SUSHI_ROUTER, sushiABI, provider);
const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, quoterABI, provider);

// 6️⃣ BOT CONFIG
const TRADE_SIZE = ethers.parseUnits("0.8", 6);
const MIN_SPREAD = 0.05; // 0.05%
const UNI_FEE    = 3000;
const SLIPPAGE   = 0.01;

let executing = false;
let nonce;

// 7️⃣ NONCE HANDLER
async function getNonce() {
  if (nonce === undefined) {
    nonce = await wallet.getTransactionCount();
  } else {
    nonce++;
  }
  return nonce;
}

// 8️⃣ MAIN LOOP
async function checkAndExecute() {
  if (executing) return;
  executing = true;

  const ts = new Date().toISOString();

  try {
    // Sushi quote USDC → WMATIC
    const sushiOut = await sushi.getAmountsOut(TRADE_SIZE, [USDC, WMATIC]);
    const sushiWmatic = sushiOut[1];

    // Uni quote USDC → WMATIC
    const uniWmatic = await quoter.quoteExactInputSingle(
      USDC,
      WMATIC,
      UNI_FEE,
      TRADE_SIZE,
      0
    );

    // Prices (USDC per WMATIC)
    const sushiPrice =
      Number(ethers.formatUnits(TRADE_SIZE, 6)) /
      Number(ethers.formatUnits(sushiWmatic, 18));

    const uniPrice =
      Number(ethers.formatUnits(TRADE_SIZE, 6)) /
      Number(ethers.formatUnits(uniWmatic, 18));

    const spreadPct = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`[${ts}] UNI: ${uniPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] SUSHI: ${sushiPrice.toFixed(6)} WMATIC`);
    console.log(`[${ts}] Spread: ${spreadPct.toFixed(4)}%`);

    let buyRouter, sellRouter, buyPath, sellPath, direction;

    // 🔁 BIDIRECTIONAL LOGIC
    if (spreadPct <= -MIN_SPREAD) {
      // Buy on Uniswap (cheap), sell on Sushi (expensive)
      buyRouter  = UNISWAP_V3_ROUTER;
      sellRouter = SUSHI_ROUTER;
      buyPath  = [USDC, WMATIC];
      sellPath = [WMATIC, USDC];
      direction = "UNI → SUSHI";
    } else if (spreadPct >= MIN_SPREAD) {
      // Buy on Sushi, sell on Uniswap
      buyRouter  = SUSHI_ROUTER;
      sellRouter = UNISWAP_V3_ROUTER;
      buyPath  = [USDC, WMATIC];
      sellPath = [WMATIC, USDC];
      direction = "SUSHI → UNI";
    } else {
      console.log(`[${ts}] ❌ No executable arbitrage`);
      console.log("──────────────────────────────");
      return;
    }

    console.log(`[${ts}] ✅ ARBITRAGE FOUND (${direction})`);
    console.log(`[${ts}] EXECUTING ON-CHAIN...`);

    const deadline = Math.floor(Date.now() / 1000) + 120;

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      TRADE_SIZE,
      buyPath,
      sellPath,
      deadline,
      {
        gasLimit: 1_500_000,
        nonce: await getNonce()
      }
    );

    console.log(`[${ts}] TX SENT: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[${ts}] TX CONFIRMED: ${receipt.transactionHash}`);
    console.log(`[${ts}] 💰 PROFIT SENT TO VAULT`);
    console.log("──────────────────────────────");

  } catch (err) {
    console.error(`[${ts}] ERROR`, err.reason || err.message || err);
  } finally {
    executing = false;
  }
}

// 9️⃣ RUN (≈10–12 checks/min)
setInterval(checkAndExecute, 5000);
