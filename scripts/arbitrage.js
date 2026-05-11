import "dotenv/config";
import { ethers } from "ethers";

/* ================= RPC ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);

/* ================= WALLET ================= */

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  process.env.WALLET_PRIVATE_KEY ||
  process.env.SECRET_KEY;

if (!PRIVATE_KEY) {
  console.log("❌ PRIVATE KEY MISSING");
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS = "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const ABI = [
  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns (tuple(uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",
  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",
  "function minimumProfitUSDC() view returns (uint256)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/* ================= ROUTERS ================= */

const QUICKSWAP = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP  = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= TOKENS ================= */

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  DAI:  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ================= DYNAMIC SIZES ================= */

const candidateSizes = Array.from({ length: 6 }, (_, i) =>
  ethers.parseUnits((50 * Math.pow(2, i)).toString(), 6)
);

/* ================= LOG FORMAT ================= */

function scanLog(token, profit, size) {
  console.log(`🔎 SCANNING ${token}`);
  console.log(`📊 Profit: ${profit.toFixed(6)}`);
  console.log(`⚡ Efficiency: ${Math.floor(profit * 1e6)}`);
  console.log(`📐 SCALE: ${Math.floor(profit * 4)}x`);
  console.log(`🚀 SIZE: ${ethers.formatUnits(size, 6)} USDC\n`);
}

/* ================= ENGINE ================= */

async function start() {
  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED\n");

  const minProfit = Number(await contract.minimumProfitUSDC()) / 1e6;

  console.log("🧠 STATIC CHECK READY");
  console.log(`📌 MIN PROFIT: ${minProfit} USDC\n`);

  while (true) {
    let best = null;

    for (const [name, token] of Object.entries(TOKENS)) {
      try {

        /* ================= FIX: MULTI-HOP ROUTE ================= */

        const pathToToken = [USDC, TOKENS.WETH, token];
        const pathToUSDC = [token, TOKENS.WETH, USDC];

        const res = await contract.findBestFlashLoanSize(
          QUICKSWAP,
          SUSHISWAP,
          candidateSizes,
          pathToToken,
          pathToUSDC
        );

        const profit = Number(res.estimatedProfit) / 1e6;

        // FIX: ignore fake zero signals
        if (!res || profit <= 0) continue;

        scanLog(name, profit, res.amountIn);

        if (!best || profit > best.profit) {
          best = {
            name,
            token,
            profit,
            size: res.amountIn,
            pathToToken,
            pathToUSDC
          };
        }

      } catch (e) {
        continue;
      }
    }

    if (!best) {
      console.log("❌ NO VALID SIGNAL\n🔎 CONTINUING SCAN...\n");
      continue;
    }

    console.log("🏆 BEST SIGNAL");
    console.log(`TOKEN: ${best.name}`);
    console.log(`PROFIT: ${best.profit.toFixed(6)}`);
    console.log(`SIZE: ${ethers.formatUnits(best.size, 6)} USDC\n`);

    /* ================= STATIC CHECK ================= */

    if (best.profit < minProfit) {
      console.log("❌ STATIC CHECK FAILED\n🔎 CONTINUING SCAN...\n");
      continue;
    }

    console.log("🧠 STATIC CHECK PASSED");
    console.log("🔥 EXECUTING TRADE");

    try {
      const tx = await contract.executeBestFlashLoanArbitrage(
        QUICKSWAP,
        SUSHISWAP,
        candidateSizes,
        best.pathToToken,
        best.pathToUSDC,
        Math.floor(Date.now() / 1000) + 120
      );

      console.log("📡 TX SENT");
      console.log(`TX: ${tx.hash}`);

      const receipt = await tx.wait();

      console.log("⚡ AAVE CALLBACK");
      console.log("🔁 SWAPS COMPLETE");
      console.log("💰 FLASH REPAID");
      console.log("🏦 PROFIT RETAINED");
      console.log(`BLOCK: ${receipt.blockNumber}\n`);

    } catch (err) {
      console.log("❌ TX FAILED");
      console.log(err.shortMessage || err.message);
    }

    console.log("🔎 CONTINUING SCAN...\n");
  }
}

start();
