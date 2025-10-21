// scripts/arbitrage.js
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

// --- Load Environment Variables ---
const { RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, MIN_PROFIT, AMOUNT_IN } = process.env;

// --- Token list ---
const TOKENS = {
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  KLIMA: { address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
};

// --- Router list ---
const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
};

// --- Load ABI ---
function loadAbi() {
  const abiPath = path.join(process.cwd(), "abi", "AaveFlashArb.json");
  if (!fs.existsSync(abiPath)) throw new Error("ABI file missing");
  return JSON.parse(fs.readFileSync(abiPath, "utf-8"));
}

// --- Main ---
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, loadAbi().abi, wallet);

  console.log("✅ Connected as", await wallet.getAddress());

  const minProfitParsed = ethers.parseUnits(MIN_PROFIT, 6); // USDC has 6 decimals
  const amountInParsed = ethers.parseUnits(AMOUNT_IN, 6);

  for (const [symbol, token] of Object.entries(TOKENS)) {
    try {
      // --- Simulate arbitrage
      await contract.callStatic.executeArbitrage(
        ROUTERS.QuickSwap,
        ROUTERS.SushiSwap,
        token.address,
        amountInParsed
      );

      console.log(`💰 Arbitrage possible for ${symbol}. Sending transaction...`);

      const tx = await contract.executeArbitrage(
        ROUTERS.QuickSwap,
        ROUTERS.SushiSwap,
        token.address,
        amountInParsed
      );

      const receipt = await tx.wait();
      console.log(`✅ Executed ${symbol}, tx: ${tx.hash}`);

    } catch (err) {
      console.log(`❌ No profitable arbitrage for ${symbol}`);
    }
  }
}

// --- Run periodically ---
const SCAN_INTERVAL_MIN = 5; // minutes
setInterval(() => {
  console.log("🔎 Scanning token list for arbitrage...");
  main();
}, SCAN_INTERVAL_MIN * 60 * 1000);

// Initial run
main();
