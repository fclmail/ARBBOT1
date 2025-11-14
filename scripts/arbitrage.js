import { ethers, parseUnits } from "ethers"; // ethers v6
import dotenv from "dotenv";
dotenv.config();

import AAVE_FLASH_ARB_ABI from "../abis/AaveFlashArb.json"; // save your ABI as JSON

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Routers
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73" // optional: will skip if invalid
};

// Tokens to scan
const tokens = [
  "0x172370d5Cd63279eFa6d502DAB29171933a610AF", // CRV
  "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", // LINK
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"  // WBTC
];

// Minimum profit in USDC
const MIN_PROFIT_USDC = parseUnits("1", 6); // 1 USDC

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------- CONTRACT INSTANCE ----------------
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, AAVE_FLASH_ARB_ABI, wallet);

// ---------------- HELPERS ----------------
async function isValidRouter(router) {
  try {
    const code = await provider.getCode(router);
    return code !== "0x";
  } catch (err) {
    return false;
  }
}

function getRouterPairs() {
  const validRouters = Object.entries(routers).filter(([name, addr]) => addr && addr !== "");
  return validRouters;
}

// ---------------- ARBITRAGE SCAN ----------------
async function scanAndExecute() {
  console.log("🚀 Starting arbitrage scan...");

  for (const token of tokens) {
    const routerPairs = getRouterPairs();

    for (let i = 0; i < routerPairs.length; i++) {
      for (let j = 0; j < routerPairs.length; j++) {
        if (i === j) continue;

        const [buyName, buyRouter] = routerPairs[i];
        const [sellName, sellRouter] = routerPairs[j];

        // Skip invalid routers (like Dfyn if needed)
        if (!(await isValidRouter(buyRouter)) || !(await isValidRouter(sellRouter))) {
          console.warn(`⚠️ Skipping invalid router pair: ${buyName} -> ${sellName}`);
          continue;
        }

        // Dummy price simulation, replace with your price fetch logic
        const buyPrice = Math.random() * 100;
        const sellPrice = buyPrice * (1 + Math.random() * 0.2);

        const estimatedProfit = sellPrice - buyPrice; // simplified for demo

        if (parseUnits(estimatedProfit.toString(), 6).gte(MIN_PROFIT_USDC)) {
          console.log(`🚨 Opportunity: Buy:${buyName} -> Sell:${sellName} | Token: ${token}`);
          console.log(`Estimated profit: ${estimatedProfit.toFixed(6)} USDC`);

          // Attempt execution
          try {
            const tx = await arbContract.executeArbitrage(
              buyRouter,
              sellRouter,
              token,
              parseUnits("1000", 6) // example amount, change as needed
            );
            console.log(`✅ Trade submitted: ${tx.hash}`);
            await tx.wait();
            console.log("✅ Trade confirmed!");
          } catch (err) {
            console.error(`⚠️ Trade failed: ${err.message}`);
          }
        }
      }
    }
  }
}

// ---------------- MAIN ----------------
(async () => {
  console.log("🟢 Connected to contract:", CONTRACT_ADDRESS);
  console.log("👤 Wallet address:", wallet.address);

  await scanAndExecute();
})();


