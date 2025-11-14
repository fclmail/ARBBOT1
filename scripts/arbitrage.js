import { ethers } from "ethers";
import "dotenv/config";

// ================= CONFIG =================
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

const ROUTERS = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Dfyn: "0xA8b607Aa09B6A2641CF6F90f643E76d3F6E6Ff73"
};

const MIN_PROFIT_USDC = ethers.parseUnits("1", 6); // minimum 1 USDC profit
const GAS_LIMIT = 1_000_000;
const GAS_PRICE_GWEI = 60;

// ================= ABI INLINED =================
const AAVE_FLASH_ARB_ABI = [
  {
    "inputs": [
      { "internalType": "address","name": "buyRouter","type": "address" },
      { "internalType": "address","name": "sellRouter","type": "address" },
      { "internalType": "address","name": "token","type": "address" },
      { "internalType": "uint256","name": "amountIn","type": "uint256" }
    ],
    "name": "executeArbitrage",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs":[
      {"internalType":"address","name":"_aavePool","type":"address"},
      {"internalType":"address","name":"_usdc","type":"address"},
      {"internalType":"uint256","name":"_minProfit","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"constructor"
  },
  {
    "inputs":[{"internalType":"uint256","name":"_minProfit","type":"uint256"}],
    "name":"setMinProfit",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "inputs":[{"internalType":"address","name":"token","type":"address"}],
    "name":"withdrawProfit",
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"USDC","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}
];

// ================= PROVIDER & WALLET =================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const arbContract = new ethers.Contract(CONTRACT_ADDRESS, AAVE_FLASH_ARB_ABI, wallet);

// ================= MOCK PRICE DATA / SCANNER =================
// Replace this with your real price feeds or DEX SDK calls
const opportunities = [
  {
    token: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    buyRouter: ROUTERS.QuickSwap,
    sellRouter: ROUTERS.SushiSwap,
    buyPrice: 212.2586,
    sellPrice: 221.9045
  }
];

async function main() {
  console.log("🚀 Aave Flash Arbitrage Bot running on Polygon...");
  console.log(`🟢 Contract: ${CONTRACT_ADDRESS}`);

  const owner = await arbContract.owner();
  console.log(`👤 Contract owner: ${owner}`);

  console.log("🔍 Starting arbitrage scan...");

  for (const opp of opportunities) {
    const grossProfit = opp.sellPrice - opp.buyPrice;
    console.log(`🚨 Opportunity: Buy:${opp.buyRouter} @ $${opp.buyPrice.toFixed(6)} → Sell:${opp.sellRouter} @ $${opp.sellPrice.toFixed(6)} | Estimated gross profit: ${grossProfit.toFixed(6)} USDC`);

    try {
      // Estimate gas
      const gasPrice = ethers.parseUnits(GAS_PRICE_GWEI.toString(), "gwei");
      const gasEstimate = await arbContract.estimateGas.executeArbitrage(
        opp.buyRouter,
        opp.sellRouter,
        opp.token,
        ethers.parseUnits("10", 6) // example borrow amount: 10 USDC
      );

      const txCostUSDC = Number(gasEstimate) * Number(gasPrice) / 1e6 / 1e18; // rough MATIC → USDC estimate
      const netProfit = grossProfit - txCostUSDC;

      console.log(`💸 Gas estimate: ${gasEstimate} | gasPrice: ${GAS_PRICE_GWEI} gwei => ~${txCostUSDC.toFixed(6)} USDC`);
      console.log(`🧮 Net profit after gas (approx): ${netProfit.toFixed(6)} USDC`);

      // Contract balance before
      const usdcBalanceBefore = await (async () => {
        try {
          return await arbContract.USDC().then(async usdcAddr => {
            const erc20 = new ethers.Contract(usdcAddr, [{"constant":true,"inputs":[{"name":"user","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}], provider);
            const bal = await erc20.balanceOf(CONTRACT_ADDRESS);
            return Number(ethers.formatUnits(bal, 6));
          });
        } catch { return 0; }
      })();
      console.log(`🏦 Contract USDC balance (before): ${usdcBalanceBefore.toFixed(6)} USDC`);

      // Send tx
      const tx = await arbContract.executeArbitrage(
        opp.buyRouter,
        opp.sellRouter,
        opp.token,
        ethers.parseUnits("10", 6),
        { gasLimit: GAS_LIMIT, gasPrice }
      );

      console.log(`⏳ Trade sent: ${tx.hash} — waiting...`);
      const receipt = await tx.wait();
      console.log(`✅ Tx mined: ${receipt.transactionHash} | block ${receipt.blockNumber} | gasUsed ${receipt.gasUsed}`);

      // Contract balance after
      const usdcBalanceAfter = await (async () => {
        try {
          return await arbContract.USDC().then(async usdcAddr => {
            const erc20 = new ethers.Contract(usdcAddr, [{"constant":true,"inputs":[{"name":"user","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}], provider);
            const bal = await erc20.balanceOf(CONTRACT_ADDRESS);
            return Number(ethers.formatUnits(bal, 6));
          });
        } catch { return 0; }
      })();
      console.log(`🏦 Contract USDC balance (after): ${usdcBalanceAfter.toFixed(6)} USDC`);
      console.log(`💹 Net USDC change for contract this tx: ${(usdcBalanceAfter - usdcBalanceBefore).toFixed(6)} USDC`);
      console.log("🔍 Scan pass finished.\n");

    } catch (err) {
      console.error("⚠️ Trade failed or reverted:", err.message || err);
    }
  }
}

main().catch(console.error);


