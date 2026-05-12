import "dotenv/config";
import { ethers } from "ethers";

/* ================= RPC ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);

/* ================= KEY LOADING ================= */

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  process.env.WALLET_PRIVATE_KEY ||
  process.env.SECRET_KEY;

if (!PRIVATE_KEY) {
  console.log("❌ PRIVATE KEY MISSING");
  console.log("👉 Set PRIVATE_KEY in environment / GitHub Secrets");
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

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

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  DAI:  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

// Token decimals mapping for proper display
const TOKEN_DECIMALS = {
  WETH: 18,
  DAI: 18,
  USDT: 6,
  WBTC: 8,
  WMATIC: 18
};

/* ================= USDC (for flash loan) ================= */

// The flash loan token - assuming USDC on Polygon
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";  // Polygon USDC
const USDC_DECIMALS = 6;

/* ================= CANDIDATE SIZES ================= */

const candidateSizes = [
  ethers.parseUnits("25", USDC_DECIMALS),
  ethers.parseUnits("50", USDC_DECIMALS),
  ethers.parseUnits("100", USDC_DECIMALS),
  ethers.parseUnits("250", USDC_DECIMALS),
  ethers.parseUnits("500", USDC_DECIMALS)
];

/* ================= LOGGING ================= */

function scanLog(token, profit, size, profitRaw) {
  console.log(`🔎 SCANNING ${token}`);
  console.log(`📊 Profit: ${profit.toFixed(6)} USDC`);
  console.log(`⚡ Raw Profit: ${profitRaw.toString()}`);
  console.log(`📐 SCALE: ${Math.floor(profit * 4)}x`);
  console.log(`🚀 SIZE: ${ethers.formatUnits(size, USDC_DECIMALS)} USDC\n`);
}

/* ================= ENGINE ================= */

async function start() {
  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED\n");
  console.log("📋 Configuration:");
  console.log(`   Flash Loan Token: USDC (${USDC})`);
  console.log(`   QuickSwap: ${QUICKSWAP}`);
  console.log(`   SushiSwap: ${SUSHISWAP}\n`);

  try {
    const minProfitRaw = await contract.minimumProfitUSDC();
    const minProfit = Number(minProfitRaw) / 1e6;
    console.log("💡 MIN PROFIT THRESHOLD:", minProfit, "USDC");
    console.log("✅ CONTRACT VERIFIED\n");
  } catch (err) {
    console.log("❌ FAILED TO READ CONTRACT:", err.message);
    process.exit(1);
  }

  while (true) {
    try {
      await new Promise(r => setTimeout(r, 500));  // Increased delay

      let best = null;

      for (const [name, token] of Object.entries(TOKENS)) {
        try {
          // The path from flash loan token to target token
          // USDC → targetToken (on DEX A)
          const pathToToken = [USDC, token];
          
          // The path from target token back to flash loan token
          // targetToken → USDC (on DEX B)
          const pathToUSDC = [token, USDC];

          console.log(`📡 Checking ${name}...`);
          console.log(`   Path A (QuickSwap): ${pathToToken[0].slice(0,10)}... → ${pathToToken[1].slice(0,10)}...`);
          console.log(`   Path B (SushiSwap): ${pathToUSDC[0].slice(0,10)}... → ${pathToUSDC[1].slice(0,10)}...`);

          const res = await contract.findBestFlashLoanSize(
            QUICKSWAP,
            SUSHISWAP,
            candidateSizes,
            pathToToken,
            pathToUSDC
          );

          if (!res || res.amountIn === 0n) {
            console.log(`   ⚠️ No valid pool found for ${name}\n`);
            continue;
          }

          const profit = Number(res.estimatedProfit) / 1e6;
          const size = res.amountIn;

          scanLog(name, profit, size, res.estimatedProfit);

          if (!best || profit > best.profit) {
            best = { name, token, profit, size, pathToToken, pathToUSDC };
          }
        } catch (err) {
          console.log(`   ❌ Error checking ${name}: ${err.shortMessage || err.message}\n`);
        }
      }

      if (!best) {
        console.log("❌ NO VALID SIGNALS FOUND THIS ROUND");
        console.log("🔎 CONTINUING SCAN...\n");
        continue;
      }

      console.log("🏆 BEST SIGNAL");
      console.log(`TOKEN: ${best.name}`);
      console.log(`PROFIT: ${best.profit.toFixed(6)} USDC`);
      console.log(`SIZE: ${ethers.formatUnits(best.size, USDC_DECIMALS)} USDC\n`);

      if (best.profit <= minProfit) {
        console.log("❌ PROFIT BELOW THRESHOLD");
        console.log(`   Required: ${minProfit.toFixed(6)} USDC`);
        console.log(`   Got: ${best.profit.toFixed(6)} USDC`);
        console.log("🔎 CONTINUING SCAN...\n");
        continue;
      }

      console.log("✅ PROFIT ABOVE THRESHOLD");
      console.log("🔥 EXECUTING ARBITRAGE\n");

      try {
        const tx = await contract.executeBestFlashLoanArbitrage(
          QUICKSWAP,
          SUSHISWAP,
          candidateSizes,
          best.pathToToken,
          best.pathToUSDC,
          Math.floor(Date.now() / 1000) + 120  // 2 minute deadline
        );

        console.log("📡 TRANSACTION SENT");
        console.log(`TX HASH: ${tx.hash}\n`);

        const receipt = await tx.wait();

        console.log("✅ TRANSACTION CONFIRMED");
        console.log(`   BLOCK: ${receipt.blockNumber}`);
        console.log(`   GAS USED: ${receipt.gasUsed.toString()}`);
        console.log("🔎 CONTINUING SCAN...\n");

      } catch (txError) {
        console.log("❌ TRANSACTION FAILED");
        console.log(`   ${txError.shortMessage || txError.message}`);
        console.log("🔎 CONTINUING SCAN...\n");
      }

    } catch (e) {
      console.log("❌ CYCLE ERROR");
      console.log(`   ${e.shortMessage || e.message}`);
      console.log("🔎 CONTINUING SCAN...\n");
    }
  }
}

start();
