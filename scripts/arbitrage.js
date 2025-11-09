import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

// RPC & Wallet
const RPC_URL = process.env.RPC_URL || "https://winter-maximum-shard.matic.quiknode.pro/336e53ee889720bcc1faed189dd19d54686dcb26/";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // your wallet key (never commit!)
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY in environment");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Deployed arbitrage contract
const CONTRACT_ADDRESS = "0x19b64f74553ee0ee26ba01bf34321735e4701c43".toLowerCase();

// Router addresses (lowercased to fix checksum issues)
const ROUTER_A = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506".toLowerCase(); // SushiSwap
const ROUTER_B = "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff".toLowerCase(); // QuickSwap

// Tokens
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174".toLowerCase();
const TOKEN = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f".toLowerCase(); // USDT
const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619".toLowerCase();

// Trade and profit config
const TRADE_AMOUNT_USDC = 100n * 1_000_000n; // $100 in base units
const MIN_PROFIT_USDC = 1n; // 0.000001 USDC (1 base unit)

// ─────────────────────────────────────────────
// ABIs
// ─────────────────────────────────────────────
const UNISWAP_V2_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const ARB_CONTRACT_ABI = [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function fmt(n, dec = 6) {
  return (Number(n) / 10 ** dec).toFixed(6);
}

function safeAddr(addr) {
  return ethers.getAddress(addr.toLowerCase());
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.log(`🔗 Using contract: ${CONTRACT_ADDRESS}`);
  console.log(`🔧 Provider: Polygon RPC`);
  console.log(`🔧 Wallet: ${wallet.address}`);
  console.log(`🔧 Decimals: USDC=6, TOKEN=6`);
  console.log(`🔧 Trade Amount: $${fmt(TRADE_AMOUNT_USDC, 6)}`);
  console.log(`🔧 MIN_PROFIT_USDC: $${fmt(MIN_PROFIT_USDC, 6)} (base units: ${MIN_PROFIT_USDC})`);

  const routerA = new ethers.Contract(ROUTER_A, UNISWAP_V2_ABI, provider);
  const routerB = new ethers.Contract(ROUTER_B, UNISWAP_V2_ABI, provider);

  const arbContract = new ethers.Contract(CONTRACT_ADDRESS, ARB_CONTRACT_ABI, wallet);

  console.log("🚀 Starting bidirectional live arbitrage scanner...");

  provider.on("block", async (blockNumber) => {
    console.log(`[${blockNumber}] 🔍 Scanning both directions...`);
    await scanDirection("A→B", routerA, routerB, arbContract);
    await scanDirection("B→A", routerB, routerA, arbContract);
  });
}

// ─────────────────────────────────────────────
// SCAN LOGIC
// ─────────────────────────────────────────────
async function scanDirection(label, buyRouter, sellRouter, arbContract) {
  try {
    const buyPath = [USDC, TOKEN];
    const sellPath = [TOKEN, USDC];
    let buyOut, sellOut;

    // 1️⃣ Try direct USDC→TOKEN
    try {
      const out = await buyRouter.getAmountsOut(TRADE_AMOUNT_USDC, buyPath);
      buyOut = out[out.length - 1];
    } catch {
      console.warn(`[${label}] ⚠️ No direct pool for buy path, retrying via WETH...`);
      const path = [USDC, WETH, TOKEN];
      const out = await buyRouter.getAmountsOut(TRADE_AMOUNT_USDC, path);
      buyOut = out[out.length - 1];
    }

    // 2️⃣ Try sell TOKEN→USDC
    try {
      const outSell = await sellRouter.getAmountsOut(buyOut, sellPath);
      sellOut = outSell[outSell.length - 1];
    } catch {
      console.warn(`[${label}] ⚠️ No direct pool for sell path, retrying via WETH...`);
      const path = [TOKEN, WETH, USDC];
      const outSell = await sellRouter.getAmountsOut(buyOut, path);
      sellOut = outSell[outSell.length - 1];
    }

    const profit = sellOut - TRADE_AMOUNT_USDC;
    const profitPct = (Number(profit) / Number(TRADE_AMOUNT_USDC)) * 100;

    console.log(`[${label}] 💱 Buy → $${fmt(TRADE_AMOUNT_USDC)} → ${fmt(buyOut)} TOKEN`);
    console.log(`[${label}] 💲 Sell → $${fmt(sellOut)} USDC`);
    console.log(`[${label}] 🧮 Profit → $${fmt(profit)} (${profitPct.toFixed(4)}%)`);

    // 3️⃣ If profitable — simulate then execute
    if (profit > MIN_PROFIT_USDC) {
      try {
        await arbContract.callStatic.executeArbitrage(
          buyRouter.target,
          sellRouter.target,
          TOKEN,
          TRADE_AMOUNT_USDC
        );
        console.log(`[${label}] ✅ Simulation passed — Executing trade...`);

        const tx = await arbContract.executeArbitrage(
          buyRouter.target,
          sellRouter.target,
          TOKEN,
          TRADE_AMOUNT_USDC,
          { gasLimit: 1_500_000 }
        );
        console.log(`[${label}] ⛓️  TX submitted: ${tx.hash}`);
        await tx.wait();
        console.log(`[${label}] ✅ Arbitrage executed successfully!`);
      } catch (err) {
        console.warn(`[${label}] ⚠️ Simulation/Execution failed: ${err.message}`);
      }
    } else {
      console.log(`[${label}] 🚫 Not profitable (below threshold).`);
    }
  } catch (err) {
    console.error(`[${label}] ❌ Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// ENTRY
// ─────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
