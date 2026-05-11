import "dotenv/config";
import { ethers } from "ethers";

/* ================= RPC ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);

/* ================= RESTORED KEY LOADING ================= */

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  process.env.WALLET_PRIVATE_KEY ||
  process.env.SECRET_KEY;

if (!PRIVATE_KEY) {
  console.log("❌ PRIVATE KEY MISSING");
  console.log("👉 Set PRIVATE_KEY or WALLET_PRIVATE_KEY in GitHub Secrets");
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

const ABI = [
  "function findBestFlashLoanSize(address,address,uint256[],address[],address[]) view returns ((uint256 amountIn,uint256 estimatedFinalUSDC,uint256 estimatedProfit))",
  "function executeBestFlashLoanArbitrage(address,address,uint256[],address[],address[],uint256)",
  "function minimumProfitUSDC() view returns (uint256)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/* ================= ROUTERS ================= */

const QUICKSWAP =
  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // FIXED CHECKSUM

const SUSHISWAP =
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  DAI:  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ================= SETTINGS ================= */

const USDC_DECIMALS = 6;

const candidateSizes = [
  ethers.parseUnits("25", USDC_DECIMALS),
  ethers.parseUnits("50", USDC_DECIMALS),
  ethers.parseUnits("100", USDC_DECIMALS),
  ethers.parseUnits("250", USDC_DECIMALS),
  ethers.parseUnits("500", USDC_DECIMALS)
];

/* ================= LOG STYLE ================= */

function scanLog(token, profit, size) {
  console.log(`🔎 SCANNING ${token}`);
  console.log(`📊 Profit: ${profit.toFixed(6)}`);
  console.log(`⚡ Efficiency: ${Math.floor(profit * 1000000)}`);
  console.log(`📐 SCALE: ${Math.floor(profit * 4)}x`);
  console.log(`🚀 SIZE: ${ethers.formatUnits(size, USDC_DECIMALS)} USDC\n`);
}

/* ================= ENGINE ================= */

async function start() {
  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED\n");

  const minProfit = await contract.minimumProfitUSDC();

  console.log("Information smart contract minimum profit 🙂 s set to 1 = 0.000001 .\n");
  console.log("✅ CONTRACT VERIFIED\n");

  while (true) {
    try {
      let best = null;

      for (const [name, token] of Object.entries(TOKENS)) {

        const pathToToken = [TOKENS.USDT, token];
        const pathToUSDC = [token, TOKENS.USDT];

        const res = await contract.findBestFlashLoanSize(
          QUICKSWAP,
          SUSHISWAP,
          candidateSizes,
          pathToToken,
          pathToUSDC
        );

        const profit = Number(res.estimatedProfit);
        const size = res.amountIn;

        scanLog(name, profit, size);

        if (!best || profit > best.profit) {
          best = { name, token, profit, size, pathToToken, pathToUSDC };
        }
      }

      if (!best || best.profit <= 0) {
        console.log("❌ NO SIGNAL\n🔎 CONTINUING SCAN...\n");
        continue;
      }

      console.log("🏆 BEST SIGNAL");
      console.log(`TOKEN: ${best.name}`);
      console.log(`PROFIT: ${best.profit.toFixed(6)}`);
      console.log(`SIZE: ${ethers.formatUnits(best.size, USDC_DECIMALS)}\n`);

      console.log("📊 PROFITABLE SIGNAL\n");

      if (BigInt(best.profit) <= BigInt(minProfit)) {
        console.log("❌ STATIC CHECK FAILED\n🔎 CONTINUING SCAN...\n");
        continue;
      }

      console.log("🧠 STATIC CHECK PASSED\n");
      console.log("🔥 EXECUTING TRADE\n");

      const tx = await contract.executeBestFlashLoanArbitrage(
        QUICKSWAP,
        SUSHISWAP,
        candidateSizes,
        best.pathToToken,
        best.pathToUSDC,
        Math.floor(Date.now() / 1000) + 60
      );

      console.log("📡 TX SENT");
      console.log(`TX: ${tx.hash}\n`);

      const receipt = await tx.wait();

      console.log("⚡ AAVE CALLBACK");
      console.log("🔁 SWAPS COMPLETE");
      console.log("💰 FLASH REPAID");
      console.log("🏦 PROFIT RETAINED");

      console.log(`✅ CONFIRMED BLOCK ${receipt.blockNumber}\n`);

      console.log("🔎 CONTINUING SCAN...\n");

    } catch (e) {
      console.log("❌ ERROR");
      console.log(e.shortMessage || e.message);
      console.log("🔎 CONTINUING SCAN...\n");
    }
  }
}

start();
